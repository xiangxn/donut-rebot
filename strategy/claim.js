import { STRATEGY_OPERATORS, STRATEGY_TYPES } from "../constants/index.js";
import { parseEther } from "viem";

/**
 * 奖励领取策略
 */
const claimStrategy = {
    operator: STRATEGY_OPERATORS.OR,
    conditions: [
        // 可领取大于value,才领取
        { type: STRATEGY_TYPES.BENEFIT, value: "10" },
    ],
    specifies: [
        {
            addresses: [],
            strategy: {
                operator: STRATEGY_OPERATORS.AND,
                // 可领取大于value,才领取
                conditions: [
                    { type: STRATEGY_TYPES.BENEFIT, value: "100" },
                ],
            },
        },
    ],
};

const evaluateStrategy = (strategy, pendingProfits) => {
    if (strategy.type) {
        switch (strategy.type) {
            case STRATEGY_TYPES.BENEFIT:
                return pendingProfits > parseEther(strategy.value);
            // ... 其他策略类型判断
            default:
                return false;
        }
    }

    if (strategy.operator === STRATEGY_OPERATORS.OR) {
        for (let condition of strategy.conditions) {
            if (evaluateStrategy(condition, pendingProfits)) {
                return true;
            }
        }
    } else if (strategy.operator === STRATEGY_OPERATORS.AND) {
        for (let condition of strategy.conditions) {
            if (!evaluateStrategy(condition, pendingProfits)) {
                return false;
            }
        }
        return true;
    }

    return false;
};

/**
 * 检查是否领取奖励
 * @param {*} subject 
 * @param {*} pendingProfits 
 * @returns 
 */
export const shouldClaim = (subject, pendingProfits) => {
    // 检查是否地址在 specifies 中
    for (let specify of claimStrategy.specifies) {
        if (
            specify.addresses.some(
                (address) => address.toLowerCase() === subject.toLowerCase()
            )
        ) {
            return evaluateStrategy(specify.strategy, pendingProfits);
        }
    }

    // 如果地址不在 specifies 中, 使用默认策略
    return evaluateStrategy(claimStrategy, pendingProfits);
};