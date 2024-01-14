import { STRATEGY_OPERATORS, STRATEGY_TYPES } from "../constants/index.js";

/**
 * 购买策略
 * 涉及价格，金额的单位统一为 ETH、BTC
 */
export const BuyStrategy = {
    operator: STRATEGY_OPERATORS.OR,
    conditions: [
        {
            operator: STRATEGY_OPERATORS.AND,
            conditions: [
                // 接收数量
                { type: STRATEGY_TYPES.RECEIVE_AMOUNT, value: 85 },
                // 社交信用分数,大于此值才会买入
                { type: STRATEGY_TYPES.SOCIAL_CREDIT, value: 8000 },
                // 账户 nonce
                { type: STRATEGY_TYPES.ACCOUNT_NONCE, value: 20 },
            ],
        },
        {
            operator: STRATEGY_OPERATORS.AND,
            conditions: [
                // 接收数量
                { type: STRATEGY_TYPES.RECEIVE_AMOUNT, value: 30 },
                // 社交信用分数,大于此值才会买入
                { type: STRATEGY_TYPES.SOCIAL_CREDIT, value: 20000 },
                // 账户 nonce
                { type: STRATEGY_TYPES.ACCOUNT_NONCE, value: 20 },
            ],
        },
        {
            operator: STRATEGY_OPERATORS.AND,
            conditions: [
                // 接收数量
                { type: STRATEGY_TYPES.RECEIVE_AMOUNT, value: 16 },
                // 社交信用分数,大于此值才会买入
                { type: STRATEGY_TYPES.SOCIAL_CREDIT, value: 40000 },
                // 账户 nonce
                { type: STRATEGY_TYPES.ACCOUNT_NONCE, value: 20 },
            ],
        },
        {
            // 白名单
            type: STRATEGY_TYPES.WHITELIST,
            whitelist: [
                { username: "necklace_btc", minReceiveAmount: 85 },
                { username: "elonmusk", minReceiveAmount: 20 },
            ],
        },
    ],
    // 每个使用多少资金买入
    buyUseFunds: 0.0005,
    // 质押比例(购买成功后自动质押的比例)
    stakeRatio: 0.60
};

// 不自动购买的地址
const notBuyList = [
];

export const couldBeBought = (subject) => {
    const isIn = notBuyList.some(address => address.toLowerCase() === subject.toLowerCase());
    return !isIn;
}

export const isWhitelisted = (keyUser) => {
    const whitelistedUser = BuyStrategy.conditions.find(
        (condition) => condition.type === STRATEGY_TYPES.WHITELIST
    );
    if (!whitelistedUser) return false;

    const user = whitelistedUser.whitelist.find(
        (u) => u.username === keyUser.username
    );

    return user;
};

const evaluateCondition = (condition, accountInfo, keyUser) => {
    switch (condition.type) {
        case STRATEGY_TYPES.SOCIAL_CREDIT:
            return keyUser.cc >= condition.value;
        case STRATEGY_TYPES.ACCOUNT_NONCE:
            return accountInfo.nonce <= condition.value;
        case STRATEGY_TYPES.RECEIVE_AMOUNT:
            return accountInfo.receiveAmount >= condition.value;
        case STRATEGY_TYPES.WHITELIST:
            const user = condition.whitelist.find(
                (u) => u.username === keyUser.username
            );
            return user && accountInfo.receiveAmount >= user.minReceiveAmount;
        default:
            throw new Error("Unknown condition type");
    }
};

export const shouldFetchNonce = () => {
    return containsNonceCondition(BuyStrategy);
};

const containsNonceCondition = (strategy) => {
    if (strategy.conditions) {
        for (let condition of strategy.conditions) {
            if (condition.type === STRATEGY_TYPES.ACCOUNT_NONCE) {
                return true;
            }
            if (condition.operator && containsSocialCreditConditions(condition)) {
                // 如果是 AND 或 OR 条件
                return true;
            }
        }
    }
    return false;
};
const containsSocialCreditConditions = (strategy) => {
    if (strategy.conditions) {
        for (let condition of strategy.conditions) {
            if (condition.type === STRATEGY_TYPES.SOCIAL_CREDIT) {
                return true;
            }
            if (condition.operator && containsSocialCreditConditions(condition)) {
                // 如果是 AND 或 OR 条件
                return true;
            }
        }
    }
    return false;
};

export const shouldBuy = (accountInfo, keyUser) => {
    return evaluateStrategy(BuyStrategy, accountInfo, keyUser);
};

const evaluateStrategy = (strategy, accountInfo, keyUser) => {
    if (strategy.operator) {
        if (strategy.operator === STRATEGY_OPERATORS.AND) {
            return strategy.conditions.every((condition) =>
                evaluateStrategy(condition, accountInfo, keyUser)
            );
        } else if (strategy.operator === STRATEGY_OPERATORS.OR) {
            return strategy.conditions.some((condition) =>
                evaluateStrategy(condition, accountInfo, keyUser)
            );
        } else {
            throw new Error("Unknown operator");
        }
    } else {
        return evaluateCondition(strategy, accountInfo, keyUser);
    }
};