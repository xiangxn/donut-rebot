import { readFileSync, promises } from "fs";
import axios from "axios";
import chalk from "chalk";
import readlineSync from "readline-sync";
import {
    sleep,
    getDir,
    decrypt,
    logIntro,
    logWork,
    formatDate
} from "./utils/index.js";

import {
    createPublicClient,
    http,
    createWalletClient,
    webSocket,
    parseGwei,
    formatEther,
    parseEther,
    BaseError, ContractFunctionRevertedError
} from "viem";
import { bevm } from "./utils/bevm.js";
import { privateKeyToAccount } from "viem/accounts";
import consoleStamp from "console-stamp";
import { couldBeSold, shouldSell } from "./strategy/sell.js";
import { shouldClaim } from "./strategy/claim.js";
import { shouldUnstake } from "./strategy/unstake.js";
import {
    BuyStrategy,
    isWhitelisted,
    shouldFetchNonce,
    shouldBuy,
    shouldFetchTwitterInfo
} from "./strategy/buy.js";

import { getUserInfo } from "./utils/twitter-count.js";

const config = JSON.parse(readFileSync(getDir("config.json"), "utf8"));
const wallets = JSON.parse(readFileSync(getDir("wallets.json"), "utf8"));
const shareABI = JSON.parse(readFileSync(getDir("abi.json"), "utf-8"));
const donutABI = JSON.parse(readFileSync(getDir("donutabi.json"), "utf-8"));

var isRun = false;

// process.on('SIGINT', async function () {
//     isRun = false;
// });

const checkAndUpdateBotJSON = async (subject) => {
    try {
        // 读取 bot.json 文件
        const data = await promises.readFile("bots.json", "utf8");
        const botData = JSON.parse(data);

        // 判断是否为数组并且 subject 是否已经存在其中
        if (Array.isArray(botData) && !botData.includes(subject)) {
            botData.push(subject);

            // 写回更新后的数据
            await promises.writeFile("bots.json", JSON.stringify(botData, null, 2));
            console.log(`Added ${subject} to bots.json`);
        }
    } catch (error) {
        console.error("Error updating bots.json:", error);
    }
};

const publicClient = createPublicClient({
    chain: bevm,
    transport: http(config.http_rpc),
});

const websocketClient = createPublicClient({
    chain: bevm,
    transport: webSocket(config.ws_rpc),
});

const hoursSinceCreatedAt = (timeStamp) => {
    const createdAt = parseInt(timeStamp, 10);
    if (createdAt <= 0) return 0;

    // 获取当前的 Unix 时间戳（毫秒）
    const now = Date.now() / 1000;

    // 计算时间差（毫秒）
    const differenceInMilliseconds = now - createdAt;

    // 转换为小时并向下取整
    const differenceInHours = Math.floor(
        differenceInMilliseconds / (1000 * 60 * 60)
    );

    return differenceInHours;
};

const calculateTransactionCost = (transaction) => {
    const gasUsed = BigInt(transaction.gasUsed);
    const gasPrice = BigInt(transaction.gasPrice);
    const value = BigInt(transaction.txAmount);

    // 计算总成本
    const totalCost = gasUsed * gasPrice * BigInt(2) + value;

    return totalCost.toString();
};

const fetchProfile = async (subject, count = 0) => {
    const user = await fetchUserName(subject);
    if (user && "username" in user) {
        try {
            const res = await axios.get(
                `${config.data_api}/users/byUsername?username=${user.username}`,
                {
                    timeout: 6000,
                    proxy: false
                }
            );
            if (res.data?.twitterId) {
                return {
                    twitterId: res.data.twitterId,
                    username: res.data.username,
                    subject: subject.toString().toLowerCase(),
                    cc: res.data.cc,
                    balance: BigInt(0),
                    staking: null,
                    pendingProfits: BigInt(0),
                    supply: 0,
                    cost: null,
                    positions: BigInt(0),
                    // 新增字段,可以用于策略判断
                    followers: res.data.followers,
                    following: res.data.following,
                    verified: res.data.verified,
                    donutFollowers: res.data.donutFollowers
                };
            } else {
                if (count < 2) {
                    await sleep(1);
                    return await fetchProfile(subject, count + 1);
                } else {
                    console.log(
                        chalk.yellow(
                            user.username,
                            "无法在 donut 获取到信息,跳过..."
                        )
                    );
                    return {};
                }
            }
        } catch (error) {
            console.log("fetchProfile error: ", error)
            if (error.message.includes("404") && count < 2) {
                await sleep(1);
                return await fetchProfile(subject, count + 1);
            }
            return {};
        }
    }
    return {};
};

const fetchUserName = async (subject, count = 0) => {
    try {
        const res = await axios.get(
            `${config.data_api}/users/getUserByEth?ethAddress=${subject}`,
            {
                timeout: 6000,
                proxy: false
            }
        );
        if (res.data?.twitterId) {
            const username = res.data?.username;
            const twitterId = res.data.twitterId;
            if (!username) {
                console.log(
                    chalk.yellow(
                        subject,
                        "无法在 donut 获取到信息，疑似幽灵账号，跳过..."
                    )
                );
                return {};
            }
            return {
                subject: subject,
                username,
                twitterId
            };
        } else {
            if (count < 2) {
                await sleep(1);
                return await fetchUserName(subject, count + 1);
            } else {
                console.log(
                    chalk.yellow(
                        subject,
                        "无法在 donut 获取到信息，疑似幽灵账号，跳过..."
                    )
                );
                return {};
            }
        }
    } catch (error) {
        console.log("fetchUserName error: ", error)
        if (error.message.includes("404") && count < 2) {
            await sleep(1);
            return await fetchUserName(subject, count + 1);
        }
        return {};
    }
};

const main = async (wallet) => {
    const client = createWalletClient({
        account: privateKeyToAccount(`0x${wallet.wif}`),
        chain: bevm,
        transport: http(config.http_rpc),
    });

    let profile = await fetchProfile(wallet.address);
    // console.log("profile:", profile);
    wallet = { ...wallet, twitterId: profile.twitterId, username: profile.username };

    const createEventQueue = [];   //创建IPShare的事件队列
    const tradeEventQueue = [];   //交易IPShare的事件队列
    const gasLimit = BigInt(config.gasLimit);
    /**
     {
        twitterId: '1355390985908314122',
        username: 'twitter user name',
        subject: '0xcad3330b0815e769784912c0c36add3a4ff4106a',
        cc: 8910.076969957303,
        balance: 88452763505566710236n,
        staking: {
            staker: '0xcad3330B0815e769784912C0C36add3A4fF4106A',
            amount: 0n,
            redeemAmount: 0n,
            unlockTime: 0n,
            debts: 0n,
            profit: 0n,
            startTime: 0
        },
        pendingProfits: 0n,
        supply: 0,
        cost: { value: BigInt(0), time: 0 },
        positions: 88452763505566710236n
    }
     */
    let holdings = [];
    let nonce = 0;
    let unWatchCreate;
    let unWatchTrade;

    const readHoldings = async () => {
        const fileName = `holding-${wallet.address.slice(-6)}.json`;
        try {
            const data = await promises.readFile(fileName, "utf8");
            holdings = JSON.parse(data, (key, value) => {
                switch (key) {
                    case "balance":
                    case "amount":
                    case "redeemAmount":
                    case "unlockTime":
                    case "debts":
                    case "profit":
                    case "pendingProfits":
                    case "supply":
                    case "value":
                    case "positions":
                        return BigInt(value);
                    default:
                        return value;
                }
            });
            // console.log("holdings:", holdings);
        } catch (error) {
            // console.error(`Error read holding ${fileName}:`, error);
        }
    };

    const saveHoldings = async () => {
        const fileName = `holding-${wallet.address.slice(-6)}.json`;
        try {
            await promises.writeFile(fileName, JSON.stringify(holdings, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
        } catch (error) {
            console.error(`Error save holding ${fileName}:`, error);
        }
    };

    const freshNonce = async () => {
        try {
            console.log(chalk.green("刷新 nonce..."));
            const transactionCount = await publicClient.getTransactionCount({
                address: wallet.address,
            });
            nonce = transactionCount;
        } catch (error) {
            await sleep(2);
            await freshNonce();
        }
    };

    /**
    * 监听创建IPShare事件
    */
    const watchCreateEvent = async (clog = false) => {
        if (clog) console.log(chalk.green("监听创建事件..."))
        if (unWatchCreate) unWatchCreate();
        unWatchCreate = websocketClient.watchContractEvent({
            address: config.shareAddress,
            abi: shareABI,
            eventName: "CreateIPshare",
            onError: error => {
                console.log(chalk.red("watchCreateEvent error:", error))
            },
            onLogs: (logs) => {
                logs.forEach((log) => {
                    // @ts-ignore
                    console.log("Create event:", log.args.subject, formatEther(log.args.amount));
                    createEventQueue.push(log)
                })
            }
        });
    };

    /**
    * 监听交易IPShare事件
    */
    const watchTradeEvent = async (clog = false) => {
        if (clog) console.log(chalk.green("监听交易事件..."))
        if (unWatchTrade) unWatchTrade();
        unWatchTrade = websocketClient.watchContractEvent({
            address: config.shareAddress,
            abi: shareABI,
            eventName: "Trade",
            onError: error => {
                console.log(chalk.red("watchTradeEvent error:", error));
            },
            onLogs: (logs) => {
                logs.forEach((log) => {
                    // @ts-ignore
                    console.log("Trade event:", log.args.subject, log.args.isBuy ? "Buy" : "Sell");
                    tradeEventQueue.push(log)
                });
            }
        });
    };

    /**
     * 处理创建事件
     */
    const procCreateEvent = async () => {
        let lastTime = Date.now();
        while (isRun) {
            if (!unWatchCreate) {
                watchCreateEvent(true);
            }
            const log = createEventQueue.shift();
            if (log) {
                // console.log(log);
                if (log.eventName === "CreateIPshare") {
                    await tryBuy(log);
                }
                lastTime = Date.now();
            } else {
                let t = (Date.now() - lastTime) / 1000;
                if (t >= config.listen_timeout) {  // 指定时间没有收到事件就重启监听
                    watchCreateEvent();
                    lastTime = Date.now();
                }
            }
            await sleep(1);
        }
    };

    /**
     * 处理交易事件
     */
    const procTradeEvent = async () => {
        let lastTime = Date.now();
        while (isRun) {
            if (!unWatchTrade) {
                watchTradeEvent(true);
            }
            const log = tradeEventQueue.shift();
            if (log) {
                /**
                args:{
                    trader: '0xcad3330B0815e769784912C0C36add3A4fF4106A',
                    subject: '0xcad3330B0815e769784912C0C36add3A4fF4106A',
                    isBuy: true,
                    shareAmount: 8098004980242949071n,
                    ethAmount: 97000000000000n,
                    protocolEthAmount: 2425000000000n,
                    subjectEthAmount: 4365000000000n,
                    supply: 88452763505566710236n
                }
                */
                let share = null;
                if (log.eventName === "Trade") {
                    const args = log.args;
                    if (args.isBuy === true) {  // 买入事件
                        share = await updateBalance(args.subject.toString().toLowerCase(), args.supply);
                        if (share) {
                            // 处理是否卖出
                            await trySell(share, log);
                            // 处理是否解除质押
                            await tryUnstake(share, log);
                        }
                    } else {    // 卖出事件
                        // 处理是否unstake
                        share = await updateBalance(args.subject.toString().toLowerCase(), args.supply);
                        if (share) {
                            await tryUnstake(share, log);
                        }
                        // TODO: 或者买入新的share ?
                    }
                    if (share) {
                        await tryClaim(share);
                        await tryRedeem(share);
                    }
                }
                lastTime = Date.now();
            } else {
                let t = (Date.now() - lastTime) / 1000;
                if (t >= config.listen_timeout) {  // 指定时间没有收到事件就重启监听
                    watchTradeEvent();
                    lastTime = Date.now();
                }
            }
            await sleep(1);
        }
    };

    const tryUnstake = async (share, log) => {
        if (share.staking.amount > BigInt(0)) {
            let stakeDuration = hoursSinceCreatedAt(share.staking.startTime);
            if (share.pendingProfits > BigInt(0)) { //如果有奖励,就不处理超时解压
                stakeDuration = 0;
            }
            if (shouldUnstake(share.subject, share.supply, stakeDuration)) {
                console.log(chalk.yellow("unstake", share.subject, "supply:", formatEther(share.supply), "stakeDuration:", stakeDuration, "amount:", formatEther(share.staking.amount)));
                const isUnstake = await unstakeShare(share.subject, share.staking.amount);
                console.log("isUnstake:", isUnstake);
                if (isUnstake) {
                    await updateBalance(share.subject);
                }
            }
        }
    };

    const tryBuy = async (log) => {
        const args = log.args;
        const buyUseFunds = parseEther(BuyStrategy.buyUseFunds.toString());
        // 检查钱包余额、share相关信息
        const [walletBalance, keyUser, buyAmount] = await Promise.all([
            publicClient.getBalance({ address: wallet.address }),
            fetchProfile(args.subject),
            getBuyAmountByValue(args.amount, buyUseFunds)
        ]);
        const need = gasLimit + buyUseFunds;
        if (walletBalance < need) {
            console.log(chalk.red("钱包余额不足! 当前:", formatEther(walletBalance), "至少需要:", formatEther(need)));
            return;
        }
        // console.log("keyUser:", keyUser)
        if (!keyUser || ("username" in keyUser === false)) {
            return;
        }

        const accountInfo = { nonce: 0, receiveAmount: parseFloat(formatEther(buyAmount)), followers: 0, posts: 0 };
        const whitelistedUser = isWhitelisted(keyUser);
        if (!whitelistedUser) {
            if (shouldFetchTwitterInfo()) {
                const info = await getUserInfo(keyUser.username);
                accountInfo.followers = info.followers_count;
                accountInfo.posts = info.statuses_count;
            }
            if (shouldFetchNonce()) {
                accountInfo.nonce = await publicClient.getTransactionCount({
                    address: args.subject,
                });
                if (accountInfo.nonce > 200) {
                    console.log(`nonce: ${accountInfo.nonce}`);
                    await checkAndUpdateBotJSON(keyUser.subject);
                }
            }
        }
        // console.log("accountInfo:", accountInfo);
        if (shouldBuy(accountInfo, keyUser)) {
            logWork({
                walletAddress: wallet.address,
                actionName: "buy",
                subject: `${keyUser.subject} - ${keyUser.username}`,
                price: BuyStrategy.buyUseFunds.toString(),
                amount: accountInfo.receiveAmount.toString(),
            });
            const isBuy = await buyShare(
                buyUseFunds,
                keyUser.subject,
                buyAmount
            );
            console.log("isBuy:", isBuy);
            if (isBuy) {
                keyUser.cost = { value: buyUseFunds, time: Date.now() / 1000 }
                holdings.push({ ...keyUser });
                // 自动质押
                await tryStake(keyUser.subject, buyAmount);
                await updateBalance(keyUser.subject, args.amount, true);
            }
        }
    };

    const tryStake = async (subject, totalAmount) => {
        const amount = totalAmount * BigInt(BuyStrategy.stakeRatio * 1000) / BigInt(1000);
        if (amount > BigInt(0)) {
            await stakeShare(subject, amount);
        }
    };

    const trySell = async (share, buyLog) => {
        const buyer = buyLog.args.trader.toString().toLowerCase();
        if (share.balance > BigInt(0) && buyer != wallet.address.toLowerCase()) {    // 有余额就尝试卖出(buyLog.args.trader不等于自己才卖出)
            const price = await getSellPrice(share.subject, share.balance);
            console.log("price:", formatEther(price));
            if (!price) {
                return;
            }
            const profit = price - share.cost.value;
            const holdingDuration = hoursSinceCreatedAt(share.cost.time);
            console.log(chalk.green(share.subject, share.username, "balance: ", formatEther(share.balance), "profit", formatEther(profit), "holdingDuration", holdingDuration));
            if (price > BigInt(0) && couldBeSold(wallet.address, share.subject) && shouldSell(share.subject, profit, holdingDuration)) {
                console.log(chalk.yellow("selling", share.subject, "price", formatEther(price)));
                const isSold = await sellShare(share.subject, share.balance);
                console.log("isSold:", isSold);
                if (isSold) {
                    await updateBalance(share.subject);
                }
            }
        }
    };

    /**
     * 检查是否有质押奖励可以领取
     * @param {*} share 
     */
    const tryClaim = async (share) => {
        if (share.pendingProfits > BigInt(0) && shouldClaim(share.subject, share.pendingProfits)) {
            console.log(chalk.yellow("claiming", share.subject, "pendingProfits", formatEther(share.pendingProfits)));
            const isClaim = await claimShare(share);
            console.log("isClaim:", isClaim);
            if (isClaim) {
                await updateBalance(share.subject, null, true);
            }
        }
    };

    /**
     * 检查unstake的share,如果可以领取则领取
     * @param {*} share 
     */
    const tryRedeem = async (share) => {
        if (share.staking?.redeemAmount > BigInt(0)) {
            if (BigInt(Date.now() / 1000) > share.staking.unlockTime) {
                console.log(chalk.yellow("redeeming", share.subject, "redeemAmount", formatEther(share.staking.redeemAmount)));
                const isRedeem = await redeemShare(share);
                console.log("isRedeem:", isRedeem);
                if (isRedeem) {
                    await updateBalance(share.subject, null, true);
                }
            }
        }
    };

    const getSellPrice = async (subjectAddress, amount = 1) => {
        try {
            const price = await publicClient.readContract({
                address: config.shareAddress,
                abi: shareABI,
                functionName: 'getSellPriceAfterFee',
                args: [subjectAddress, amount]
            });
            // @ts-ignore
            return BigInt(price);
        } catch (error) {
            console.log("getSellPrice error:", error.message);
            return null;
        }
    };

    const getBuyPrice = async (subjectAddress, amount) => {
        try {
            const price = await publicClient.readContract({
                address: config.shareAddress,
                abi: shareABI,
                functionName: 'getBuyPriceAfterFee',
                args: [subjectAddress, amount]
            });
            // @ts-ignore
            return BigInt(price);
        } catch (error) {
            console.log("getSellPrice error:", error.message);
            return null;
        }
    };

    const getBuyAmountByValue = async (supply, value) => {
        try {
            const amount = await publicClient.readContract({
                address: config.shareAddress,
                abi: shareABI,
                functionName: 'getBuyAmountByValue',
                args: [supply, value]
            });
            // @ts-ignore
            return BigInt(amount);
        } catch (error) {
            console.log("getSellPrice error:", error.message);
            return null;
        }
    };

    const getTransactionHistory = async () => {
        try {
            const transactions = await axios.get(
                `${config.scan_api}/trans/list?page=0&pageSize=100000&account=${wallet.address}`,
                {
                    timeout: 3000,
                }
            );
            // console.log("transactions:", transactions?.data?.items)
            const succeedTransactions = (transactions?.data?.items || [])?.filter(
                (transaction) => {
                    return (
                        transaction.isToContract === true &&
                        transaction.txTo === config.donutAddress &&
                        // 只筛选出买入的交易
                        transaction.method === "e69d849d"
                    );
                }
            );
            return succeedTransactions || [];
        } catch (error) {
            await sleep(5);
            return await getTransactionHistory();
        }
    };

    const getTransaction = async (hash) => {
        /**
         {
            blockNum: 395740,
            blockTime: 1704729468,
            txHash: '0xe31ff550d6ffb2521c3741ed96a28ba914fbbd0c4d6ac330a018b708331cc405',
            txStatus: 1,
            txSender: '0xcad3330B0815e769784912C0C36add3A4fF4106C',
            txTo: '0xe86305b400E69ffFb5CF8Fce2a90659174777A79',
            isToContract: true,
            txAmount: '1000000000000000',
            transactionFee: '15463175000000',
            gasPrice: '50000000',
            gasUsed: 174150,
            gasLimit: 176722,
            inputData: 'e69d849d000000000000000000000000e27890a9f122c6df6f27a6fb92970334777016dd0000000000000000000000000000000000000000000000000000000000000000',
            decodeInputData: '',
            funcSig: '',
            formatInputData: { methodId: 'e69d849d', methodDetail: '', params: null },
            baseFeePerGas: '50000000',
            maxFeePerGas: '87500000',
            maxPriorityFeePerGas: '0',
            isEip1559: 1,
            contractAddress: '0000000000000000000000000000000000000000',
            transactionFeeRefund: '6755675000000'
            }
         */
        try {
            const transaction = await axios.get(
                `${config.scan_api}/trans/${hash}`,
                {
                    timeout: 3000,
                }
            );
            // console.log("transaction:", transaction?.data);
            return transaction?.data;
        } catch (error) {
            await sleep(5);
            return await getTransaction(hash);
        }
    };

    const refreshHoldings = async () => {
        await freshNonce();
        console.log(chalk.green("刷新Holding数据..."));
        await readHoldings();
        try {
            // const res = await axios.get(
            //     `${config.data_api}/users/followingList?twitterId=${wallet.twitterId}`,
            //     {
            //         timeout: 3000,
            //         proxy: false
            //     }
            // );
            const res = await axios.post(
                `${config.graphql_api}?`,
                {
                    operationName: null,
                    variables: null,
                    query: `{ account( id: "${wallet.address}") { holdings { edges { node { subject { id } } } } } }`
                },
                {
                    timeout: 3000,
                    proxy: false
                }
            );
            if (res.data && ("errors" in res.data) === false) {
                const arr = res.data?.data?.account?.holdings?.edges.map((v) => ({ donutEth: v.node.subject.id }));
                await mergePositions(arr);
            } else {
                holdings = [];
            }
        } catch (error) {
            console.log("refreshHoldings error: ", error.message);
            await sleep(3);
            await refreshHoldings();
        }
    };

    const getSupply = async (arr) => {
        let calls = arr.map(item => ({
            address: config.shareAddress,
            abi: shareABI,
            functionName: "ipshareSupply",
            args: [item.donutEth]
        }));
        const reps = await publicClient.multicall({ contracts: calls, multicallAddress: config.multicall })
        // console.log("reps: ", reps)
        const supplys = {};
        reps.forEach((v, i) => {
            supplys[arr[i].donutEth.toString().toLowerCase()] = v.result;
        });
        return supplys;
    };

    const getBalances = async (arr) => {
        let calls = arr.map(item => ({
            address: config.shareAddress,
            abi: shareABI,
            functionName: "ipshareBalance",
            args: [item.donutEth, wallet.address]
        }));
        const reps = await publicClient.multicall({ contracts: calls, multicallAddress: config.multicall })
        // console.log("reps: ", reps)
        const balances = {};
        reps.forEach((v, i) => {
            balances[arr[i].donutEth.toString().toLowerCase()] = v.result;
        });
        return balances;
    };

    const getProfiles = async (arr) => {
        let reqs = arr.map(item => fetchProfile(item.donutEth));
        const results = await Promise.all(reqs);
        const profiles = {};
        results.forEach((v, i) => {
            profiles[arr[i].donutEth.toString().toLowerCase()] = v;
        });
        return profiles;
    };

    const updateBalance = async (subject, supply = null, updateStake = false) => {
        let s = holdings.find((s) => s.subject == subject);
        if (s) {
            let calls = [
                {
                    address: config.shareAddress,
                    abi: shareABI,
                    functionName: "ipshareBalance",
                    args: [subject, wallet.address]
                },
                {
                    address: config.shareAddress,
                    abi: shareABI,
                    functionName: "getStakerInfo",
                    args: [subject, wallet.address]
                },
                {
                    address: config.shareAddress,
                    abi: shareABI,
                    functionName: "getPendingProfits",
                    args: [subject, wallet.address]
                }
            ];
            const reps = await publicClient.multicall({ contracts: calls, multicallAddress: config.multicall });
            s.balance = reps[0].result;
            if (updateStake) {
                // @ts-ignore
                s.staking = { ...reps[1].result, startTime: Date.now() / 1000 };
            } else {
                // @ts-ignore
                s.staking = { ...reps[1].result, startTime: s.staking?.startTime || 0 };
            }
            s.pendingProfits = reps[2].result;
            s.positions = s.balance + s.staking.amount + s.staking.redeemAmount + s.pendingProfits;
            if (supply) {
                s.supply = supply;
            }
            await saveHoldings();
            return s;
        }
        return null;
    };

    const getStakings = async (arr) => {
        let calls = arr.map(item => ({
            address: config.shareAddress,
            abi: shareABI,
            functionName: "getStakerInfo",
            args: [item.donutEth, wallet.address]
        }));
        const reps = await publicClient.multicall({ contracts: calls, multicallAddress: config.multicall })
        // console.log("reps: ", reps)
        const stakings = {};
        reps.forEach((v, i) => {
            stakings[arr[i].donutEth.toString().toLowerCase()] = v.result;
        });
        return stakings;
    };

    const getPendingProfits = async (arr) => {
        let calls = arr.map(item => ({
            address: config.shareAddress,
            abi: shareABI,
            functionName: "getPendingProfits",
            args: [item.donutEth, wallet.address]
        }));
        const reps = await publicClient.multicall({ contracts: calls, multicallAddress: config.multicall })
        // console.log("reps: ", reps)
        const profits = {};
        reps.forEach((v, i) => {
            profits[arr[i].donutEth.toString().toLowerCase()] = v.result;
        });
        return profits;
    };

    const mergePositions = async (arr) => {
        if (!arr || arr.length < 1) return;
        // console.log("arr:", arr);
        const subjectMap = {};
        const [balances, stakings, pendingProfits, supplys, profiles] = await Promise.all([
            getBalances(arr),
            getStakings(arr),
            getPendingProfits(arr),
            getSupply(arr),
            getProfiles(arr)
        ]);
        arr.forEach((item) => {
            const subject = item.donutEth.toString().toLowerCase();
            subjectMap[subject] = {
                twitterId: item.twitterId,
                username: item.username,
                subject: subject,
                cc: item.cc,
                balance: balances[subject],
                staking: { ...stakings[subject], startTime: 0 },
                pendingProfits: pendingProfits[subject],
                supply: supplys[subject],
                cost: { value: BigInt(0), time: 0 },
                positions: balances[subject] + stakings[subject].amount + stakings[subject].redeemAmount + pendingProfits[subject],
                followers: profiles[subject].followers,
                following: profiles[subject].following,
                verified: profiles[subject].verified,
                donutFollowers: profiles[subject].donutFollowers
            };

        });
        // console.log("subjectMap: ", subjectMap);
        const subjects = Object.values(subjectMap).filter((item) => {
            return item.positions;
        });
        // 处理质押时间与买入时间
        subjects.forEach((holding) => {
            let index = holdings.findIndex((v) => v.subject == holding.subject);
            if (index > -1) {
                let old = holdings[index];
                holding.staking.startTime = old.staking.startTime == 0 ? Date.now() / 1000 : old.staking.startTime;
                holding.cost = { value: old.cost.value, time: old.cost.time == 0 ? Date.now() / 1000 : old.cost.time }
            }
        });
        holdings = subjects;
        console.log(chalk.yellow("holdings:", holdings.length));
        await saveHoldings();
    };

    const sellShare = async (subjectAddress, amount) => {
        if (amount <= BigInt(0)) return false;
        try {
            await freshNonce();
            const { request } = await publicClient.simulateContract({
                account: privateKeyToAccount(`0x${wallet.wif}`),
                address: config.shareAddress,
                abi: shareABI,
                functionName: "sellShares",
                args: [subjectAddress, amount],
                gas: gasLimit,
                // gasPrice: parseGwei(config.gasPrice),
                nonce: nonce++
            });
            const hash = await client.writeContract(request);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log(
                chalk[receipt.status === "success" ? "green" : "red"](
                    `Sell ${subjectAddress} ${receipt.status}`
                )
            );
            if (receipt.status == 'success') {
                return true;
            }
            return false;
        } catch (err) {
            console.error("sellShare error:", err);
            if (err instanceof BaseError) {
                const revertError = err.walk(err => err instanceof ContractFunctionRevertedError)
                if (revertError instanceof ContractFunctionRevertedError) {
                    const errorName = revertError.data?.errorName ?? ''
                    console.log(chalk.red("sellShare error:", errorName));
                }
            }
            return false;
        }
    };

    const buyShare = async (value, subjectAddress, amount) => {
        if (amount <= BigInt(0)) return false;
        try {
            await freshNonce();
            const data = {
                account: privateKeyToAccount(`0x${wallet.wif}`),
                address: config.donutAddress,
                abi: donutABI,
                functionName: "donate",
                args: [subjectAddress, BigInt(0)],
                value: value,
                gas: gasLimit,
                // gasPrice: parseGwei(config.gasPrice),
                nonce: nonce++
            };
            const { request } = await publicClient.simulateContract(data);
            const hash = await client.writeContract(request);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log(
                chalk[receipt.status === "success" ? "green" : "red"](
                    `Buy ${subjectAddress} ${receipt.status}`
                )
            );
            if (receipt.status == 'success') {
                return true;
            }
            return false;
        } catch (err) {
            console.error("buyShare error:", err);
            if (err instanceof BaseError) {
                const revertError = err.walk(err => err instanceof ContractFunctionRevertedError)
                if (revertError instanceof ContractFunctionRevertedError) {
                    const errorName = revertError.data?.errorName ?? ''
                    console.log(chalk.red("buyShare error:", errorName));
                }
            }
            return false;
        }
    };

    const claimShare = async (share) => {
        if (share.pendingProfits <= BigInt(0)) return false;
        try {
            await freshNonce();
            const { request } = await publicClient.simulateContract({
                account: privateKeyToAccount(`0x${wallet.wif}`),
                address: config.shareAddress,
                abi: shareABI,
                functionName: "claim",
                args: [share.subject],
                gas: gasLimit,
                // gasPrice: parseGwei(config.gasPrice),
                nonce: nonce++
            });
            const hash = await client.writeContract(request);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log(
                chalk[receipt.status === "success" ? "green" : "red"](
                    `Claim ${share.subject} ${receipt.status}`
                )
            );
            if (receipt.status == 'success') {
                return true;
            }
            return false;
        } catch (err) {
            console.error("claimShare error:", err);
            if (err instanceof BaseError) {
                const revertError = err.walk(err => err instanceof ContractFunctionRevertedError)
                if (revertError instanceof ContractFunctionRevertedError) {
                    const errorName = revertError.data?.errorName ?? ''
                    console.log(chalk.red("claimShare error:", errorName));
                }
            }
            return false;
        }
    };

    const redeemShare = async (share) => {
        if (share.staking.redeemAmount <= BigInt(0)) return false;
        try {
            await freshNonce();
            const { request } = await publicClient.simulateContract({
                account: privateKeyToAccount(`0x${wallet.wif}`),
                address: config.shareAddress,
                abi: shareABI,
                functionName: "redeem",
                args: [share.subject],
                gas: gasLimit,
                // gasPrice: parseGwei(config.gasPrice),
                nonce: nonce++
            });
            const hash = await client.writeContract(request);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log(
                chalk[receipt.status === "success" ? "green" : "red"](
                    `Redeem ${share.subject} ${receipt.status}`
                )
            );
            if (receipt.status == 'success') {
                return true;
            }
            return false;
        } catch (err) {
            console.error("redeemShare error:", err);
            if (err instanceof BaseError) {
                const revertError = err.walk(err => err instanceof ContractFunctionRevertedError)
                if (revertError instanceof ContractFunctionRevertedError) {
                    const errorName = revertError.data?.errorName ?? ''
                    console.log(chalk.red("redeemShare error:", errorName));
                }
            }
            return false;
        }
    };

    const unstakeShare = async (subject, amount) => {
        if (amount <= BigInt(0)) return false;
        try {
            await freshNonce();
            const { request } = await publicClient.simulateContract({
                account: privateKeyToAccount(`0x${wallet.wif}`),
                address: config.shareAddress,
                abi: shareABI,
                functionName: "unstake",
                args: [subject, amount],
                gas: gasLimit,
                // gasPrice: parseGwei(config.gasPrice),
                nonce: nonce++
            });
            const hash = await client.writeContract(request);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log(
                chalk[receipt.status === "success" ? "green" : "red"](
                    `Unstake ${subject} ${receipt.status}`
                )
            );
            if (receipt.status == 'success') {
                return true;
            }
            return false;
        } catch (err) {
            console.error("unstakeShare error:", err);
            if (err instanceof BaseError) {
                const revertError = err.walk(err => err instanceof ContractFunctionRevertedError)
                if (revertError instanceof ContractFunctionRevertedError) {
                    const errorName = revertError.data?.errorName ?? ''
                    console.log(chalk.red("unstakeShare error:", errorName));
                }
            }
            return false;
        }
    };

    const stakeShare = async (subject, amount) => {
        if (amount <= BigInt(0)) return false;
        try {
            await freshNonce();
            const { request } = await publicClient.simulateContract({
                account: privateKeyToAccount(`0x${wallet.wif}`),
                address: config.shareAddress,
                abi: shareABI,
                functionName: "stake",
                args: [subject, amount],
                gas: gasLimit,
                // gasPrice: parseGwei(config.gasPrice),
                nonce: nonce++
            });
            const hash = await client.writeContract(request);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log(
                chalk[receipt.status === "success" ? "green" : "red"](
                    `Stake ${subject} ${receipt.status}`
                )
            );
            if (receipt.status == 'success') {
                return true;
            }
            return false;
        } catch (err) {
            console.error("stakeShare error:", err);
            if (err instanceof BaseError) {
                const revertError = err.walk(err => err instanceof ContractFunctionRevertedError)
                if (revertError instanceof ContractFunctionRevertedError) {
                    const errorName = revertError.data?.errorName ?? ''
                    console.log(chalk.red("stakeShare error:", errorName));
                }
            }
            return false;
        }
    };

    //f3d 监听
    const checkF3d = async () => {
        if (config.f3d.run !== true) return;
        console.log(chalk.green("监听f3d奖池..."))
        let interval = config.f3d.check_interval;
        let endTime = 0;
        let checkCount = 0;
        let roundInfo = null;
        while (isRun) {
            if (!endTime) {
                roundInfo = await getCurrentRoundInfo();
                // console.log("roundInfo:", roundInfo);
            } else {
                if (endTime - Date.now() <= config.f3d.buying_time * 1000) {
                    // 买入自己的share
                    await buyShare(parseEther(config.f3d.buying_price), wallet.address, BigInt(1));
                    endTime = 0;
                    interval = config.f3d.check_interval;
                    continue;
                }
                if (checkCount >= config.f3d.check_interval) {  // 检查结束时间是否变化,5分钟检查一次
                    checkCount = 0;
                    roundInfo = await getCurrentRoundInfo();
                    if (roundInfo) {
                        endTime = parseInt((roundInfo.endTime * BigInt(1000)).toString());
                        console.log(chalk.blueBright("RoundInfo rewards:", formatEther(roundInfo.rewards), "includes:", roundInfo.includes, "endTime:", formatDate(new Date(endTime))));
                        roundInfo = null;
                    }
                }
                checkCount++;
            }
            if (roundInfo) {
                let t = parseInt((roundInfo.endTime * BigInt(1000)).toString());
                if (roundInfo.rewards >= parseEther(config.f3d.min_amount) && t - Date.now() >= 6000 && roundInfo.includes == 0) {
                    endTime = t
                    console.log(chalk.yellow("RoundInfo rewards:", formatEther(roundInfo.rewards), "endTime:", formatDate(new Date(endTime))));
                    roundInfo = null;
                    interval = 1;   // 每秒检查一次
                    continue;
                }
            }
            await sleep(interval);
        }
    };

    const getCurrentRoundInfo = async () => {
        try {
            const roundInfo = await publicClient.readContract({
                address: config.donutAddress,
                abi: donutABI,
                functionName: 'getCurrentRoundInfo',
                args: []
            });
            // console.log(roundInfo)
            // @ts-ignore
            let tmp = roundInfo.filter((v) => v.toString().toLocaleLowerCase() === wallet.address.toLocaleLowerCase());
            return { rewards: roundInfo[0], endTime: roundInfo[1], includes: tmp.length };
        } catch (error) {
            console.log("getCurrentRoundInfo error:", error.message);
            return null;
        }
    };

    await refreshHoldings();
    procCreateEvent();
    procTradeEvent();
    checkF3d();
};

process.on("exit", function (code) {
    console.debug(`Rebot stopped.\n`);
});

// go go go
logIntro()
consoleStamp(console, {
    format: ":date(yyyy/mm/dd HH:MM:ss)",
});
const password1 = readlineSync.question("Password1: ", {
    hideEchoBack: true, // The typed text on screen is hidden by `*` (default).
});
const password2 = readlineSync.question("Password2: ", {
    hideEchoBack: true, // The typed text on screen is hidden by `*` (default).
});
process.env.pw1 = password1;
process.env.pw2 = password2;
if (password1 && password2) {
    isRun = true;
    for (let index = 0; index < wallets.length; index++) {
        const wallet = wallets[index];
        main({
            ...wallet,
            wif: decrypt(wallet.wif, password1, password2),
        });
    }
}