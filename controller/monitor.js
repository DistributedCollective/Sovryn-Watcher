/**
 * The monitor hecks the health of the watcher in 60s interval, provides a simple frontend to observe wallet Doc and RBtc balances and
 * if enabled sends email notifications on liquidations and margin calls
 * Errors on transactions or warnings about low wallet balances are sent to a telegram group
 */
const axios = require('axios');
const Telegram = require('telegraf/telegram');
import A from '../secrets/accounts';
import C from './contract';
import conf from '../config/config';
import U from '../util/helper';
import Arbitrage from './arbitrage';

class MonitorController {
    constructor(){
        this.marginCalls={};
        this.liquidationNotifications={};
    }

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
     * todo: define correct threshold
     * todo2: add user queue, send max 1 mail /3h
     */
    async marginCalls() {
        while (true) {
            for (let p in this.positions) {
                if (this.positions[p].currentMargin < this.positions[p].maintenanceMargin * 0.9) {
                    const tx = await this.getTransactionDetails(p);
                    if(!tx || !tx.returnValues || !tx.returnValues.user) continue;

                    const asset = this.positions[p].loanToken==conf.testTokenRBTC ? "Btc":"Doc"

                    const params = {
                        "ASSET": asset, 
                        "LIQUIDATION_PRICE": this.calculateLiquidationPrice(tx.returnValues.leverage, asset),
                        "TRANSACTION_HASH": tx.transactionHash,
                        "LEVERAGE": tx.entryLeverage,
                        "POSITION": C.web3.fromWei(this.positions[p].principal.toString(), "Ether").toFixed(5),
                        "POSITION_SIZE": tx.positionSize,
                        "CURRENT_MARGIN": C.web3.fromWei(this.positions[p].currentMargin.toString(), "Ether").toFixed(5),
                        "MAINTENANCE_MARGIN": C.web3.fromWei(this.positions[p].maintenanceMargin.toString(), "Ether").toFixed(5)
                    };

                    this.sendMarginCall({user:tx.returnValues.user, params:params});
                }
            }
            await U.wasteTime(60 * 5);
        }
    }

    //send mail if user got liquidated
    async liquidationNotification(){
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

    /**
     * Mailservice expects parameters in the form
     * {
     *  user: "user-wallet-address",
     *  params: {tx-details}
     * }
     */
    sendMarginCall(pos) {
        if(!this.logMarginCallNotifications(pos.user)) return;
        
        try {
            const res = await axios.post(conf.mailServerHost + "/sendMarginCall", {
                position: pos
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

    logMarginCallNotifications(userAdr){
        const threeHoursAgo = Date.now()-(1000*60*60*3);
        if(this.marginCalls[userAdr] && this.marginCalls[userAdr]>threeHoursAgo) return false;
        this.marginCalls[userAdr] = Date.now();
        return true;
    }


    /** 
     * Helpers
     */
     calculateLiquidationPrice(leverage, posType){
        const amount = C.web3.utils.toWei("1", "Ether");
        const priceInWei = await Arbitrage.getPriceFromPriceFeed(C.contractSwaps, conf.testTokenRBTC, conf.docToken, amount);
    
        const maxPriceMovement = 1 - ((1 + 0.15) * (leverage - 1) / leverage);
        if(posType=="Btc") return (1 - maxPriceMovement) * priceInWei;
        else return (1 + maxPriceMovement) * priceInWei;
     }
}

export default new MonitorController();