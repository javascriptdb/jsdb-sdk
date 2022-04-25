import {DatabaseMap} from "./index.js";
const notes = new DatabaseMap('notes');
tests.x.date.subscribe((value)=> {
    console.log('updated value', value);
});
setInterval(async () => notes['dsa67d5sa7da'].date = new Date(), 1000);