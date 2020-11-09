/**
 *  Accepts client requests and checks the health of the watcher in 60s interval
 *  If the system is not healthy it sends a message to the telegram group
 */
const axios = require('axios');
const Telegram = require('telegraf/telegram');
import A from '../secrets/accounts';
import C from './contract';
import conf from '../config/config';
import U from '../util/helper';

class MonitorController {

    start(positions, liquidations) {
        this.positions = positions;
        this.liquidations = liquidations;

        if (conf.errorBotTelegram != "") {
            this.telegramBotWatcher = new Telegram(conf.errorBotTelegram);
            let p = this;
            setInterval(() => {
                p.checkSystem();
            }, 1000 * 60);
        }
    }

    /**
     * Wrapper for health signals, called from client
     */
    async getSignals(cb) {
        console.log("get signals")
        const resp =
        {
            blockInfoLn: await this.getCurrentBlockPrivateNode(),
            blockInfoPn: await this.getCurrentBlockPublicNode(),
            accountInfoLiq: await this.getAccountInfo(A.liquidator),
            accountInfoRoll: await this.getAccountInfo(A.rollover),
            accountInfoArb: await this.getAccountInfo(A.arbitrage),
            positionInfo: await this.getOpenPositions(),
            liqInfo: await this.getOpenLiquidations()
        }
        if (typeof cb === "function") cb(resp);
        else return resp;
    }

    /** 
    * Internal check
    */
    async checkSystem() {
        if (conf.network == "test") return;

        const sInfo = await this.getSignals();
        for (let b in sInfo.accountInfoLiq) {
            if (sInfo.accountInfoLiq[b] < 0.001)
                this.telegramBotWatcher.sendMessage(conf.sovrynInternalTelegramId, "No money left for liquidator " + b + " on " + conf.network + " network");
        }

        for (let b in sInfo.accountInfoRoll) {
            if (sInfo.accountInfoRoll[b] < 0.001)
                this.telegramBotWatcher.sendMessage(conf.sovrynInternalTelegramId, "No money left for rollover-wallet " + b + " on " + conf.network + " network");
        }

        for (let b in sInfo.accountInfoArb) {
            if (sInfo.accountInfoArb[b] < 0.001)
                this.telegramBotWatcher.sendMessage(conf.sovrynInternalTelegramId, "No money left for arbitrage-wallet " + b + " on " + conf.network + " network");
        }
    }

    getCurrentBlockPublicNode() {
        let p = this;
        return new Promise(resolve => {
            axios({
                method: 'post',
                url: conf.publicNodeProvider,
                data: {
                    method: 'eth_blockNumber',
                    jsonrpc: "2.0",
                    params: [],
                    id: 1
                },
                headers: { "Content-Type": "application/json" }
            }).then((response) => {
                if (response.data && response.data.result) {
                    const res = parseInt(response.data.result)
                    resolve(res);
                }
                else resolve(-1);
            })
                .catch((e) => {
                    console.error("error getting block-nr from public node");
                    console.error(e);
                    resolve(-1);
                });
        });
    }

    async getCurrentBlockPrivateNode() {
        try {
            let bNr = await C.web3.eth.getBlockNumber();
            bNr = parseInt(bNr);
            return bNr;
        }
        catch (e) {
            console.error("error getting block-nr from private node");
            //console.error(e);
            return -1;
        }
    }

    async getAccountInfo(accounts) {
        let accBalances = {};

        for (let a of accounts) {
            try {
                let aInf = await C.web3.eth.getBalance(a.adr.toLowerCase());
                aInf = C.web3.utils.fromWei(aInf, 'Ether');
                accBalances[a.adr] = parseFloat(aInf);
            }
            catch (e) {
                console.error("error on retrieving account balance");
                console.error(e);
                return -1;
            }
        }
        return accBalances;
    }

    getOpenPositions() {
        return Object.keys(this.positions).length;
    }

    //todo: add from-to, to be called from cliet
    async getOpenPositionsDetails(cb) {
        if (typeof cb === "function") cb(this.positions);
    }

    getOpenLiquidations(cb) {
        return Object.keys(this.liquidations).length;
    }
    //todo: add from-to, to be called from client
    async getOpenLiquidationsDetails(cb) {
        if (typeof cb === "function") cb(this.liquidations);
    }


    /**
     * 
     */
    async marginCalls() {
        while (true) {
            for (let p in this.positions) {
                if (this.positions[p].currentMargin < this.positions[p].maintenanceMargin * 0.9) {
                    const tx = await this.getTransactionDetails(p);
                    const merged = { ...tx, ...this.positions[p] };
                    if (tx) this.sendMarginCall(merged);
                }
            }
            await U.wasteTime(60 * 5);
        }
    }

    getTransactionDetails(loanId) {
        return new Promise(resolve => {
            C.contractSovryn.getPastEvents('Trade', {
                fromBlock: 1205639,
                toBlock: 'latest',
                filter: { "loanId": loanId }
            }, (error, events) => {
                if (error) {
                    console.log("had an error"); console.log(error);
                }
                //console.log("event")
                //console.log(events);
                if (events && events.length > 0) resolve(events[0]);
                else resolve(false);
            });
        });
    }

    sendMarginCall(tx) {
        try {
            const res = await axios.post(conf.mailServerHost + "/sendMarginCall", {
                tx: tx
            }, {
                headers: {
                    Authorization: conf.mailServiceApiKey
                }
            });
            console.log("sent margin call");
            console.log(res.data);
        }
        catch (e) {
            console.log("error on sending margin call");
            console.log(e);
        }
    }
}

export default new MonitorController();