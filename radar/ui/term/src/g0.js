/* TV2-1114 新看盘终端 ↔ 旧画面的接口（放在函式外面：才读得到旧画面的全域变数）。
   这里只「转呼叫」旧画面原本的流程：买（qbBuy／多链 mctBuy）、卖（qsSell／mctSell）、限价（fdLim）、紧急全停（estopAsk）、重新设定（reSetup）。
   这些流程本来就会跳确认、检查紧急全停／手动买卖开关、再经主程式送到引擎的统一动作闸门 actionGate；这里不另外送单、不碰钱包与设定档。 */
var __tvO = {
  snap: function () { try { return typeof SNAP !== 'undefined' ? SNAP : null; } catch (e) { return null; } },
  lang: function () { try { return typeof L !== 'undefined' && L === 'en' ? 'en' : 'zh'; } catch (e) { return 'zh'; } },
  setLang: function (l) { try { if (typeof L !== 'undefined' && L !== l && typeof setLang === 'function') setLang(); } catch (e) { console.error(e); } },
  isStop: function () { try { return typeof isStop === 'function' ? !!isStop() : false; } catch (e) { return false; } },
  qb: function () { try { return typeof QB !== 'undefined' ? QB : null; } catch (e) { return null; } },
  qbSave: function () { try { localStorage.setItem('qb', JSON.stringify(QB)); } catch (e) {} },
  buyOwn: function (net, c, name, btn, amt) { return qbBuy(net, c, name, btn, 0, amt); },
  sellOwn: function (net, c, name, btn, pct) { return qsSell(net, c, name, btn, pct); },
  buyMc: function (ch, c, name, amt) { if (!window.__mct) throw new Error('mct'); return window.__mct.buy(ch, c, name, amt); },
  sellMc: function (ch, c, name, pct) { if (!window.__mct) throw new Error('mct'); return window.__mct.sell(ch, c, name, pct); },
  limit: function (W, net, c, name) { try { if (typeof fdLim === 'function') { fdLim(W, net, c, name); return true; } } catch (e) { console.error(e); } return false; },
  estop: function () { return estopAsk(); },
  reset: function () { return reSetup(); },
  toast: function (m) { try { t(m); } catch (e) {} },
  donate: function () { return openDonate(); },
  openOld: function (net, c, name) { try { return openToken(net, c, { name: name || '' }); } catch (e) { console.error(e); } },
};
