import { readFileSync } from "fs";
import { getDir } from "../utils/index.js";
import axios from "axios";
import { sleep } from "../utils/sleep.js";

function readAddress() {
    // address.json 直接从Metamask中导出"状态日志"
    let obj = JSON.parse(readFileSync(getDir("checks/address.json"), "utf8"));
    return Object.keys(obj.metamask.identities);
}

async function get_eligibility(addr) {
    // X-Recaptcha-Token 在页面(https://provisions.starknet.io) 中手工操作一次后获取
    let xrToken = "AVGAUYzZoL_R2FMxZibMrZFUPtQMq4LjWkDy4WejTOY_fa6PjP51ypJ5ZrLHFqZz70TPt9Gs62ylrkgw1Y9aO39vzCL56HuciVnTLWjzYv_PPm9WtCe1K09dpB1VXPmxRpHtduo9cTZuzdA9BI_6gemuVLZ7uwME1ekH7nqVKyz5cA:U=b7d7bec480000000"
    try {
        let res = await axios.get(addr, { headers: { 'X-Recaptcha-Token': xrToken } });
        return res.data;
    } catch (error) {
        console.log("get_eligibility failed", error.message);
    }
}


async function main() {
    let addrs = readAddress();
    for (let addr of addrs) {
        let data = await get_eligibility(`https://provisions.starknet.io/api/ethereum/get_eligibility?identity=${addr}`);
        console.info(`${addr}: ${JSON.stringify(data)}`)
        await sleep(5);
    }
}

main()