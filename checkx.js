import { getUserInfo } from "./utils/twitter-count.js";

async function main(){
    let info = await getUserInfo("elonmusk");
    console.log("info:",info)
}

main()