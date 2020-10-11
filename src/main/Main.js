const CONFIG = require('../../config/config');
const logger = require('./Loggers');
const Util = require('./Util');
const si = require('systeminformation');
const BinanceApi = require('./BinanceApi');
const MarketCache = require('./MarketCache');
const HUD = require('./HUD');
const ArbitrageExecution = require('./ArbitrageExecution');
const CalculationNode = require('./CalculationNode');
const SpeedTest = require('./SpeedTest');
const Validation = require('./Validation');

let recentCalculationTimes = [];
let recentCalculations = {};
let initialized = null;

// Helps identify application startup
logger.binance.info(logger.LINE);
logger.execution.info(logger.LINE);
logger.performance.info(logger.LINE);

Validation.configuration(CONFIG);

if (CONFIG.EXECUTION.ENABLED) console.log(`WARNING! Order execution is enabled!\n`);

process.on('uncaughtException', handleError);

si.networkStats()
    .then(() => {
        console.log(`Checking latency ...`);
        return SpeedTest.multiPing(5);
    })
    .then((pings) => {
        const msg = `Experiencing ${Util.average(pings).toFixed(0)} ms of latency`;
        console.log(msg);
        logger.performance.info(msg);
    })
    .then(() => {
        console.log(`Fetching exchange info ...`);
        return BinanceApi.exchangeInfo();
    })
    .then(exchangeInfo => MarketCache.initialize(exchangeInfo, CONFIG.SCANNING.WHITELIST, CONFIG.INVESTMENT.BASE))
    .then(checkBalances)
    .then(checkMarket)
    .then(() => {
        // Listen for depth updates
        const tickers = MarketCache.tickers.watching;
        console.log(`Opening ${Math.ceil(tickers.length / CONFIG.WEBSOCKET.BUNDLE_SIZE)} depth websockets for ${tickers.length} tickers ...`);
        if (CONFIG.WEBSOCKET.BUNDLE_SIZE === 1) {
            return BinanceApi.depthCacheStaggered(tickers, CONFIG.SCANNING.DEPTH, CONFIG.WEBSOCKET.INITIALIZATION_INTERVAL, calculateArbitrageCallback);
        } else {
            return BinanceApi.depthCacheCombined(tickers, CONFIG.SCANNING.DEPTH, CONFIG.WEBSOCKET.BUNDLE_SIZE, CONFIG.WEBSOCKET.INITIALIZATION_INTERVAL, calculateArbitrageCallback);
        }
    })
    .then(() => {
        console.log(`Waiting for all tickers to receive initial depth snapshot ...`);
        return MarketCache.waitForAllTickersToUpdate(10000);
    })
    .then(() => {
        console.log(`Initialized`);
        initialized = Date.now();

        console.log();
        console.log(`Execution Limit:        ${CONFIG.EXECUTION.CAP} execution(s)`);
        console.log(`Profit Threshold:       ${CONFIG.EXECUTION.THRESHOLD.PROFIT.toFixed(2)}%`);
        console.log(`Age Threshold:          ${CONFIG.EXECUTION.THRESHOLD.AGE} ms`);
        console.log();

        if (CONFIG.SCANNING.TIMEOUT > 0) calculateArbitrageScheduled();
        if (CONFIG.HUD.ENABLED) setInterval(() => HUD.displayArbs(recentCalculations, CONFIG.HUD.ARB_COUNT), CONFIG.HUD.REFRESH_RATE);
        if (CONFIG.LOG.STATUS_UPDATE_INTERVAL > 0) setInterval(displayStatusUpdate, CONFIG.LOG.STATUS_UPDATE_INTERVAL);
    })
    .catch(handleError);

function calculateArbitrageScheduled() {
    if (isSafeToCalculateArbitrage()) {
        const depthSnapshots = BinanceApi.getDepthSnapshots(MarketCache.tickers.watching);
        MarketCache.pruneDepthCacheAboveThreshold(depthSnapshots, CONFIG.SCANNING.DEPTH);

        const {calculationTime, successCount, errorCount, results} = CalculationNode.cycle(
            MarketCache.relationships,
            depthSnapshots,
            (e) => logger.performance.warn(e),
            ArbitrageExecution.isSafeToExecute,
            ArbitrageExecution.executeCalculatedPosition
        );

        recentCalculationTimes.push(calculationTime);
        if (CONFIG.HUD.ENABLED) Object.assign(recentCalculations, results);
        displayCalculationResults(successCount, errorCount, calculationTime);
    }

    setTimeout(calculateArbitrageScheduled, CONFIG.SCANNING.TIMEOUT);
}

function calculateArbitrageCallback(ticker) {
    if (!isSafeToCalculateArbitrage()) return;

    const relationships = MarketCache.getRelationshipsInvolvingTicker(ticker);
    const tickers = MarketCache.getTickersInvolvedInRelationships(relationships);
    const depthSnapshots = BinanceApi.getDepthSnapshots(tickers);
    MarketCache.pruneDepthCacheAboveThreshold(depthSnapshots, CONFIG.SCANNING.DEPTH);

    const {calculationTime, successCount, errorCount, results} = CalculationNode.cycle(
        relationships,
        depthSnapshots,
        (e) => logger.performance.warn(e),
        ArbitrageExecution.isSafeToExecute,
        ArbitrageExecution.executeCalculatedPosition
    );

    recentCalculationTimes.push(calculationTime);
    if (CONFIG.HUD.ENABLED) Object.assign(recentCalculations, results);
    displayCalculationResults(successCount, errorCount, calculationTime);
}

function isSafeToCalculateArbitrage() {
    if (ArbitrageExecution.inProgressIds.size > 0) return false;
    if (!initialized) return false;
    return true;
}

function displayCalculationResults(successCount, errorCount, calculationTime) {
    if (errorCount === 0) return;
    const totalCalculations = successCount + errorCount;
    logger.performance.warn(`Completed ${successCount}/${totalCalculations} (${((successCount/totalCalculations) * 100).toFixed(1)}%) calculations in ${calculationTime} ms`);
}

function displayStatusUpdate() {
    const tickersWithoutDepthUpdate = MarketCache.getWatchedTickersWithoutDepthCacheUpdate();
    if (tickersWithoutDepthUpdate.length > 0) {
        logger.performance.debug(`Tickers without a depth cache update: [${tickersWithoutDepthUpdate}]`);
    }

    logger.performance.debug(`Calculations per second: ${(CalculationNode.calculations / Util.secondsSince(initialized)).toFixed(0)}`);
    logger.performance.debug(`Calculation cycle average speed: ${Util.average(recentCalculationTimes).toFixed(2)} ms`);
    recentCalculationTimes = [];

    Promise.all([
        si.currentLoad(),
        si.networkStats(),
        SpeedTest.ping()
    ])
        .then(([load, network, latency]) => {
            logger.performance.debug(`CPU Load: ${(load.avgload * 100).toFixed(0)}% [${load.cpus.map(cpu => cpu.load.toFixed(0) + '%')}]`);
            logger.performance.debug(`Network Usage: ${Util.toKB(network[0].rx_sec).toFixed(1)} KBps (down) and ${Util.toKB(network[0].tx_sec).toFixed(1)} KBps (up)`);
            logger.performance.debug(`API Latency: ${latency} ms`);
        });
}

function handleError(err) {
    console.error(err);
    logger.binance.error(err);
    process.exit(1);
}

function checkBalances() {
    if (!CONFIG.EXECUTION.ENABLED) return;

    console.log(`Checking balances ...`);

    return BinanceApi.getBalances()
        .then(balances => {
            if (balances[CONFIG.INVESTMENT.BASE].available < CONFIG.INVESTMENT.MIN) {
                const msg = `Only detected ${balances[CONFIG.INVESTMENT.BASE].available} ${CONFIG.INVESTMENT.BASE}, but ${CONFIG.INVESTMENT.MIN} ${CONFIG.INVESTMENT.BASE} is required to satisfy your INVESTMENT.MIN configuration`;
                logger.execution.error(msg);
                throw new Error(msg);
            }
            if (balances[CONFIG.INVESTMENT.BASE].available < CONFIG.INVESTMENT.MAX) {
                const msg = `Only detected ${balances[CONFIG.INVESTMENT.BASE].available} ${CONFIG.INVESTMENT.BASE}, but ${CONFIG.INVESTMENT.MAX} ${CONFIG.INVESTMENT.BASE} is required to satisfy your INVESTMENT.MAX configuration`;
                logger.execution.error(msg);
                throw new Error(msg);
            }
            if (balances['BNB'].available <= 0.001) {
                const msg = `Only detected ${balances['BNB'].available} BNB which is not sufficient to pay for trading fees via BNB`;
                logger.execution.error(msg);
                throw new Error(msg);
            }
        });
}

function checkMarket() {
    console.log(`Checking market conditions ...`);

    if (MarketCache.relationships.length === 0) {
        const msg = `No triangular relationships were identified`;
        logger.execution.error(msg);
        throw new Error(msg);
    }

    return Promise.resolve();
}
