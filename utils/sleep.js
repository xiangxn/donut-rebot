export const sleep = async (seconds) =>
  new Promise((resolve) =>
    setTimeout(() => {
      // @ts-ignore
      resolve();
    }, seconds * 1000)
  );

/**
 * It is recommended to sleep >= 10s, and use this function only if the function needs to end in advance
 * @param {*} interval sleeping time
 * @param {*} callback step callback, Returns true to end sleep early.
 * @param {*} step Check interval, seconds
 */
export const sleep2 = async (interval, callback = null, step = 5) => {
  let t = Date.now() + interval * 1000;
  while (Date.now() < t) {
    await sleep(step);
    if (callback && callback()) break;
  }
};
