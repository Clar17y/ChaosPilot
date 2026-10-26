export interface ExtractedCreditDisplay {
  quotePrice: string;
  creditLimit: string;
  reservedCredit: string;
  usedCredit: string;
  availableCredit: string;
}

export interface ExtractedOrderDisplay {
  orderId: string;
  status: string;
  initialQuantity: number | '-';
  remainingQuantity: number | '-';
  filledQuantity: number | '-';
  cancelledQuantity: number | '-';
  price: number | '-';
  displayText: string;
}

export interface SnapshotDisplayModel {
  credit: ExtractedCreditDisplay;
  orders: ExtractedOrderDisplay[];
  hasOrders: boolean;
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Pure helper with NO DOM dependency.
 * Extracts a typed display model from nested target snapshot or fallback flat snapshot.
 * Displays actual quote, limit, reserved, used, available, and order quantities/status.
 * Guards absent or corrupt data; does not invent zeros for unavailable facts.
 */
export function extractSnapshotDisplay(rawSnapshot: unknown): SnapshotDisplayModel {
  if (!isRecord(rawSnapshot)) {
    return {
      credit: {
        quotePrice: '-',
        creditLimit: '-',
        reservedCredit: '-',
        usedCredit: '-',
        availableCredit: '-',
      },
      orders: [],
      hasOrders: false,
    };
  }

  // Look for nested target first, fallback to rawSnapshot (flat)
  const target = isRecord(rawSnapshot.target) ? rawSnapshot.target : rawSnapshot;

  // 1. Quote price: target.quote.price or fallback target.quotePrice
  let quotePriceNum: number | undefined;
  if (
    isRecord(target.quote) &&
    typeof target.quote.price === 'number' &&
    Number.isFinite(target.quote.price)
  ) {
    quotePriceNum = target.quote.price;
  } else if (typeof target.quotePrice === 'number' && Number.isFinite(target.quotePrice)) {
    quotePriceNum = target.quotePrice;
  }

  // 2. Credit limit: target.credit.limit or fallback target.creditLimit
  let creditLimitNum: number | undefined;
  if (
    isRecord(target.credit) &&
    typeof target.credit.limit === 'number' &&
    Number.isFinite(target.credit.limit)
  ) {
    creditLimitNum = target.credit.limit;
  } else if (typeof target.creditLimit === 'number' && Number.isFinite(target.creditLimit)) {
    creditLimitNum = target.creditLimit;
  }

  // 3. Reserved credit: target.reservedCredit
  let reservedCreditNum: number | undefined;
  if (typeof target.reservedCredit === 'number' && Number.isFinite(target.reservedCredit)) {
    reservedCreditNum = target.reservedCredit;
  }

  // 4. Used credit: target.usedCredit
  let usedCreditNum: number | undefined;
  if (typeof target.usedCredit === 'number' && Number.isFinite(target.usedCredit)) {
    usedCreditNum = target.usedCredit;
  }

  // 5. Available credit: limit - (reserved + used)
  // Can be negative after credit cut! Do NOT clamp to 0 or invent zeros for unavailable facts.
  let availableCreditStr = '-';
  if (
    creditLimitNum !== undefined &&
    reservedCreditNum !== undefined &&
    usedCreditNum !== undefined
  ) {
    const available = creditLimitNum - (reservedCreditNum + usedCreditNum);
    availableCreditStr = String(available);
  }

  // 6. Orders: target.orders
  const orders: ExtractedOrderDisplay[] = [];
  if (isRecord(target.orders)) {
    for (const [orderId, rawOrder] of Object.entries(target.orders)) {
      if (isRecord(rawOrder)) {
        const status = typeof rawOrder.status === 'string' ? rawOrder.status : 'UNKNOWN';
        const initialQuantity =
          typeof rawOrder.initialQuantity === 'number' && Number.isFinite(rawOrder.initialQuantity)
            ? rawOrder.initialQuantity
            : '-';
        const remainingQuantity =
          typeof rawOrder.remainingQuantity === 'number' &&
          Number.isFinite(rawOrder.remainingQuantity)
            ? rawOrder.remainingQuantity
            : '-';
        const filledQuantity =
          typeof rawOrder.filledQuantity === 'number' && Number.isFinite(rawOrder.filledQuantity)
            ? rawOrder.filledQuantity
            : '-';
        const cancelledQuantity =
          typeof rawOrder.cancelledQuantity === 'number' &&
          Number.isFinite(rawOrder.cancelledQuantity)
            ? rawOrder.cancelledQuantity
            : '-';
        const price =
          typeof rawOrder.price === 'number' && Number.isFinite(rawOrder.price)
            ? rawOrder.price
            : '-';

        const displayText = `STATUS: ${status} | Qty: ${initialQuantity} | Filled: ${filledQuantity} | Rem: ${remainingQuantity} | Cxl: ${cancelledQuantity}`;

        orders.push({
          orderId,
          status,
          initialQuantity,
          remainingQuantity,
          filledQuantity,
          cancelledQuantity,
          price,
          displayText,
        });
      }
    }
  }

  return {
    credit: {
      quotePrice: quotePriceNum !== undefined ? String(quotePriceNum) : '-',
      creditLimit: creditLimitNum !== undefined ? String(creditLimitNum) : '-',
      reservedCredit: reservedCreditNum !== undefined ? String(reservedCreditNum) : '-',
      usedCredit: usedCreditNum !== undefined ? String(usedCreditNum) : '-',
      availableCredit: availableCreditStr,
    },
    orders,
    hasOrders: orders.length > 0,
  };
}
