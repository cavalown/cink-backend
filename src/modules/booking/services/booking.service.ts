import Order from "@models/orders.model";
import { v4 as uuid4 } from "uuid";
import jwt from "jsonwebtoken";
import Session from "@models/sessions.model";
import TicketType from "@models/ticketTypes.model";
import { ErrorHandler } from "@middlewares/error_handler";
import User from "@models/user.model";
import { settings } from "@config/settings";

function generateCheckMacValue(params: any, hashKey: string, hashIV: string) {
  // Step 1: sort parameters by alphabet order
  const sortedParams = Object.keys(params)
    .sort()
    .reduce((obj, key) => {
      obj[key] = params[key];
      return obj;
    }, {});

  // Step 2: concatenate sorted parameters with HashKey and HashIV
  let checkString = `HashKey=${hashKey}`;
  for (let key in sortedParams) {
    checkString += `&${key}=${sortedParams[key]}`;
  }
  checkString += `&HashIV=${hashIV}`;

  // Step 3: URL encode
  checkString = encodeURIComponent(checkString)
    .replace(/%20/g, '+')
    .replace(/%2d/g, '-')
    .replace(/%5f/g, '_')
    .replace(/%2e/g, '.')
    .replace(/%21/g, '!')
    .replace(/%2a/g, '*')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')');

  // Step 4: to lowercase
  checkString = checkString.toLowerCase();

  // Step 5: SHA256 encryption
  const sha256 = require('crypto').createHash('sha256');
  sha256.update(checkString);
  const encryptedString = sha256.digest('hex');

  // Step 6: to uppercase
  const checkMacValue = encryptedString.toUpperCase();

  return checkMacValue;

}

function getPayMethodFromEcpay(PaymentType) {
  switch (PaymentType) {
    case 'Credit_CreditCard':
      return "信用卡"

    default:
      return "Unknow"
  }
}

function getDataTime() {
  const date = new Date();
  const tzOffset = date.getTimezoneOffset() * 60000; // 計算時區偏移量，單位為毫秒
  const isoString = new Date(Date.now() - tzOffset).toISOString();
  return isoString
}

function getEcpatDateTime(IsoStr) {
  const date = new Date(IsoStr);
  const formattedDateString = date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC'
  });
  return formattedDateString
}

export class BookingService {
  async checkData(data: any): Promise<Object> {
    //判斷有無此場次
    const selectedSession = await Session.findById(data.sessionId)

    if (selectedSession == undefined) return new ErrorHandler(400, "沒有此場次")
    //判斷選取票種是否有在該場次內
    for (let i = 0; i < data.ticketTypeIds.length; i++) {
      let isExisted;
      for (let j = 0; j < selectedSession.ticketTypeIds.length; j++) {
        if (data.ticketTypeIds[i] == selectedSession.ticketTypeIds[j].toString()) {
          isExisted = true;
          break;
        }
      }
      if (!isExisted) return new ErrorHandler(400, `該場次沒有此票種id:${data.ticketTypeIds[i]}`);
    }
    //判斷選取票種的座位與總金額是否正確
    let totalPrice = 0
    const selectedTicketTypesDB = await TicketType.find({ _id: { $in: data.ticketTypeIds } })
    const selectedTicketTypes = data.ticketTypeIds.map(
      id => selectedTicketTypesDB.find(t => t.id.toString() == id)
    )
    selectedTicketTypes.forEach(selectedTicketType => {
      totalPrice += selectedTicketType.price
    })
    if (data.price != totalPrice) return new ErrorHandler(400, "價錢與選擇票種不符")
    //讀出場次影廳的座位,確認是否有該座位,確認座位是否被選取
    const selectedSeats = selectedSession.seats.filter(seat => {
      return data.seats.some(c => c.row == seat.row && c.col == seat.col)
    })
    if (data.seats.length != selectedSeats.length) return new ErrorHandler(400, `座位選擇數量錯誤:選擇數量=${data.seats.length},票種合計數量=${selectedSeats.length}`)
    selectedSeats.forEach(seat => {
      if (seat.situation != "可販售") return new ErrorHandler(400, `部分座位row=${seat.row},col=${seat.col}已被選取`)
    })
    return ""
  }

  async hashData(authToken: any, data: any): Promise<Object> {
    //get user email from JWT
    const decode = await jwt.verify(authToken, process.env.JWT_SECRET, { complete: false });
    //get selected TicketTypes
    const selectedTicketTypes = await TicketType.find({ _id: { $in: data.ticketTypeIds } })

    const add = {
      ticketTypeName: data.ticketTypeIds.map(tid => selectedTicketTypes.find(t => t._id.toString() == tid)?.name),//["雙人吉拿套票","全票"],//前端給
      seats: data.seats.map(seat => `${seat.col}排${seat.row}`),//["8排7","8排8"],//前端給
      price: data.price,//前端給
      orderId: uuid4().replace(/-/g, '').slice(0, 20).toLowerCase(),//這裡產生,20碼英數字
      payMethod: "未付款",//未付款
      orderDatetime: getDataTime(),//這裡產生
      status: "未付款",
      sessionId: data.sessionId//from headers
    }

    const createResult: any = await Order.create(add)

    await User.findOneAndUpdate({ email: decode.email.toLowerCase() }, { $addToSet: { orderId: createResult._id } })

    const payData: any = {
      MerchantID: '3002607',
      MerchantTradeNo: createResult.orderId,
      MerchantTradeDate: getEcpatDateTime(createResult.orderDatetime),
      PaymentType: 'aio',
      TotalAmount: createResult.price.toString(),
      TradeDesc: '我是商品描述',
      ItemName: createResult.ticketTypeName.join('#'),
      ReturnURL: settings.ECPAY.ECPAY_RETURNURL,
      ChoosePayment: 'ALL',
      EncryptType: '1',
      ClientBackURL: settings.ECPAY.ECPAY_CLIENTBACKURL
    }

    payData.CheckMacValue = generateCheckMacValue(payData, settings.ECPAY.ECPAY_HASHKEY, settings.ECPAY.ECPAY_HASHIV)

    return payData;
  }

  async completedPay(body: any): Promise<Object> {
    //#region 變更座位變更為已販售
    const order = await Order.findOne({ orderId: body.MerchantTradeNo })
    if (order == null) return new ErrorHandler(400, "沒有此訂單編號")
    const searchSeats = order?.seats.map((seat, i) => {
      const [colStr, rowStr] = seat.split("排");
      const col = Number(colStr);
      const row = Number(rowStr);
      return { [`elem${i}.col`]: col, [`elem${i}.row`]: row };
    })
    const newStatus = true;
    const updateObj = {};
    order?.seats.forEach((rc, i) => {
      updateObj[`seats.$[elem${i}].isSold`] = newStatus;
    });

    let selectedSession
    try {
      selectedSession = await Session.findById(order?.sessionId)
    } catch {
      return new ErrorHandler(400, "找不到訂單編號對應的場次")
    }

    const cantUpdates = order?.seats.filter(seatStr => {
      let isFind = false;
      selectedSession?.seats.forEach(s => {
        const [colStr, rowStr] = seatStr.split("排");
        const col = Number(colStr);
        const row = Number(rowStr);
        if (s.col == col && s.row == row && s.isSold == false) {
          isFind = true
          return
        }
      })
      return !isFind
    })
    if (cantUpdates.length > 0) {
      let errMsg = ""
      cantUpdates.forEach(seat => {
        errMsg += `${seat}狀態無法更新,`
      })
      return new ErrorHandler(400, errMsg)
    }
    const resultSessionSeatUpdate = await Session.updateOne(
      { _id: order?.sessionId },
      { $set: updateObj },
      { arrayFilters: searchSeats }
    )
    //#endregion

    //訂票紀錄狀態變更為未取票
    await Order.findOneAndUpdate({ orderId: body.MerchantTradeNo }, { payMethod: getPayMethodFromEcpay(body.PaymentType), status: "未取票" })

    return '1|OK'
  }

  async reHashData(orderId: any): Promise<Object> {
    const order: any = await Order.findOne({ orderId })
    if (order == undefined) return new ErrorHandler(400, "沒有此訂單編號")
    if (order.status!='未付款') return new ErrorHandler(400, "此訂單已付款完成")

    const payData: any = {
      MerchantID: '3002607',
      MerchantTradeNo: order.orderId,
      MerchantTradeDate: getEcpatDateTime(order.orderDatetime),
      PaymentType: 'aio',
      TotalAmount: order.price.toString(),
      TradeDesc: '我是商品描述',
      ItemName: order.ticketTypeName.join('#'),
      ReturnURL: settings.ECPAY.ECPAY_RETURNURL,
      ChoosePayment: 'ALL',
      EncryptType: '1',
      ClientBackURL: settings.ECPAY.ECPAY_CLIENTBACKURL
    }

    payData.CheckMacValue = generateCheckMacValue(payData, settings.ECPAY.ECPAY_HASHKEY, settings.ECPAY.ECPAY_HASHIV)

    return payData;
  }
}