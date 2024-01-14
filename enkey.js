import { ArgumentParser } from 'argparse'
import { encrypt } from "./utils/encrypt.js"

const parser = new ArgumentParser({
    description: 'Argparse example'
});
parser.add_argument('KEY');
parser.add_argument('PASSWORD1');
parser.add_argument('PASSWORD2');

const args = parser.parse_args();

console.log(encrypt(args.KEY, args.PASSWORD1, args.PASSWORD2));