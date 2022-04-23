import {DatabaseMap} from "./index.js";
const tests = new DatabaseMap('tests');
await tests.set('x', {fuck:'YEAH!'})
tests.x.date.subscribe((value)=> {
    console.log('updated value', value);
});
setInterval(async () => tests.x.date = Date.now(), 2000);