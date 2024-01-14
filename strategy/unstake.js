import { STRATEGY_OPERATORS, STRATEGY_TYPES } from "../constants/index.js";
import { parseEther } from "viem";

/**
 * 解压策略
 */
const unstakeStrategy = {
    operator: STRATEGY_OPERATORS.OR,
    conditions: [
        // 发行量大于value就解压
        { type: STRATEGY_TYPES.BENEFIT, value: "500" },
        // 质押时间超过多少小时后没有奖励就解压
        { type: STRATEGY_TYPES.HOLDING_DURATION, value: 240 },
    ],
    specifies: [
        {
            addresses: [],
            strategy: {
                operator: STRATEGY_OPERATORS.AND,
                // 质押时间超过多少小时后没有奖励,并且发行量大于value就解压
                conditions: [
                    { type: STRATEGY_TYPES.BENEFIT, value: "1000" },
                    { type: STRATEGY_TYPES.HOLDING_DURATION, value: 120 },
                ],
            },
        },
    ],
};

const evaluateStrategy = (strategy, supply, stakeDuration) => {
    if (strategy.type) {
        switch (strategy.type) {
            case STRATEGY_TYPES.BENEFIT:
                return supply > parseEther(strategy.value);
            case STRATEGY_TYPES.HOLDING_DURATION:
                return stakeDuration > strategy.value;
            // ... 其他策略类型判断
            default:
                return false;
        }
    }

    if (strategy.operator === STRATEGY_OPERATORS.OR) {
        for (let condition of strategy.conditions) {
            if (evaluateStrategy(condition, supply, stakeDuration)) {
                return true;
            }
        }
    } else if (strategy.operator === STRATEGY_OPERATORS.AND) {
        for (let condition of strategy.conditions) {
            if (!evaluateStrategy(condition, supply, stakeDuration)) {
                return false;
            }
        }
        return true;
    }

    return false;
};

export const shouldUnstake = (subject, supply, stakeDuration) => {
    // 检查是否地址在 specifies 中
    for (let specify of unstakeStrategy.specifies) {
        if (
            specify.addresses.some(
                (address) => address.toLowerCase() === subject.toLowerCase()
            )
        ) {
            return evaluateStrategy(specify.strategy, supply, stakeDuration);
        }
    }

    // 如果地址不在 specifies 中, 使用默认策略
    return evaluateStrategy(unstakeStrategy, supply, stakeDuration);
};
