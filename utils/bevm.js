import { defineChain } from 'viem'
import { readFileSync } from "fs";
import { getDir } from "./index.js";

const config = JSON.parse(readFileSync(getDir("config.json"), "utf8"));

export const bevm = defineChain({
    id: 1502,
    name: 'BEVM',
    nativeCurrency: {
        decimals: 18,
        name: 'Bitcoin',
        symbol: 'BTC',
    },
    rpcUrls: {
        default: {
            http: [config.http_rpc],
            webSocket: [config.ws_rpc],
        },
    },
    blockExplorers: {
        default: { name: 'Explorer', url: config.explorer },
    },
    contracts: {
        multicall3: {
            address: config.multicall,
            blockCreated: 420266,
        },
    },
})