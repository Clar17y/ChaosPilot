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

// ---------------------------------------------------------------------------
// Inspected-run state presentation (domain selected by the pinned adapter)
// ---------------------------------------------------------------------------

export type StateAdapterKind = 'trading' | 'inventory' | 'unknown';

export interface StatePresentation {
  kind: StateAdapterKind;
  tabTitle: string;
  primaryTitle: string;
  secondaryTitle: string;
  primaryEmpty: string;
  secondaryEmpty: string;
}

const STATE_PRESENTATIONS: Record<StateAdapterKind, StatePresentation> = {
  trading: {
    kind: 'trading',
    tabTitle: 'Order & credit exposure',
    primaryTitle: 'Credit & Gateway Accounting',
    secondaryTitle: 'Orders Tracked',
    primaryEmpty: 'No snapshot state available.',
    secondaryEmpty: 'No orders active in snapshot.',
  },
  inventory: {
    kind: 'inventory',
    tabTitle: 'Inventory & reservations',
    primaryTitle: 'Stock by SKU',
    secondaryTitle: 'Reservations',
    primaryEmpty: 'No stock recorded in snapshot.',
    secondaryEmpty: 'No reservations recorded in snapshot.',
  },
  unknown: {
    kind: 'unknown',
    tabTitle: 'Run state',
    primaryTitle: 'State',
    secondaryTitle: 'State details',
    primaryEmpty: 'State unavailable: unknown system adapter for this run.',
    secondaryEmpty: 'State unavailable: unknown system adapter for this run.',
  },
};

export function statePresentationFor(kind: StateAdapterKind): StatePresentation {
  return STATE_PRESENTATIONS[kind];
}

export type InspectedRecordLike = {
  systemBrief?: { brief?: { adapterId?: unknown } | null } | null;
  contextAudit?: { adapterId?: unknown } | null;
} | null | undefined;

/**
 * Saved adapter id carried by an inspected record, or null when absent or
 * not a usable string. A present pinned snapshot is authoritative: only its
 * brief identity is considered, even when that identity is missing or
 * malformed. The saved context audit is used only when no brief snapshot is
 * present at all.
 */
export function inspectedRunAdapterId(
  record: InspectedRecordLike,
): string | null {
  const adapterId = record?.systemBrief
    ? record.systemBrief.brief?.adapterId
    : record?.contextAudit?.adapterId;
  return typeof adapterId === 'string' && adapterId.length > 0 ? adapterId : null;
}

/**
 * State domain for an inspected run, from its pinned brief, never from the
 * currently selected profile. Legacy records with no brief snapshot are the
 * original trading runs and stay trading; a pinned brief with an unrecognised
 * or missing adapter is unknown, never mislabeled as trading.
 */
export function stateKindForInspectedRun(
  adapterId: string | null | undefined,
  hasPinnedBrief: boolean,
): StateAdapterKind {
  if (adapterId === 'inventory-reservation') return 'inventory';
  if (adapterId === 'synthetic-trading') return 'trading';
  if (!hasPinnedBrief && (adapterId === null || adapterId === undefined)) return 'trading';
  return 'unknown';
}

export function stateKindForRecord(
  record: InspectedRecordLike,
): StateAdapterKind {
  // A pinned snapshot, when present, is authoritative, even if its identity
  // conflicts with the audit. A missing or malformed pinned identity is
  // unknown, never inferred from the audit or the currently selected system.
  if (record?.systemBrief) {
    return stateKindForInspectedRun(inspectedRunAdapterId(record), true);
  }
  // No pinned snapshot: the saved audit identity is the record's own saved
  // identity. A present but malformed/unconfigured/unrecognised adapter id
  // is honest "unknown"; only a truly identity-free record (no snapshot and
  // no audit adapter id) keeps the historical trading fallback.
  const audit = record?.contextAudit;
  if (audit && typeof audit === 'object' && audit.adapterId !== undefined) {
    return stateKindForInspectedRun(
      typeof audit.adapterId === 'string' && audit.adapterId.length > 0 ? audit.adapterId : 'unconfigured',
      true,
    );
  }
  return stateKindForInspectedRun(inspectedRunAdapterId(record), false);
}

// ---------------------------------------------------------------------------
// Inventory snapshot display model
// ---------------------------------------------------------------------------

export interface InventoryStockDisplay {
  sku: string;
  received: number | '-';
  onHand: number | '-';
  /** Sum of remaining reservations for this SKU; '-' when it cannot be derived honestly. */
  reservedRemaining: number | '-';
  /** onHand - reservedRemaining; may be negative (over-reservation is shown, not clamped). */
  available: number | '-';
  overReserved: boolean;
  displayText: string;
}

export interface InventoryReservationDisplay {
  reservationId: string;
  sku: string;
  quantity: number | '-';
  remaining: number | '-';
  shipped: number | '-';
  cancelled: number | '-';
  displayText: string;
}

export interface InventorySnapshotDisplay {
  stock: InventoryStockDisplay[];
  reservations: InventoryReservationDisplay[];
  hasStock: boolean;
  hasReservations: boolean;
  stockAvailable: boolean;
  reservationsAvailable: boolean;
}

function finiteNumber(value: unknown): number | '-' {
  return typeof value === 'number' && Number.isFinite(value) ? value : '-';
}

function textOrDash(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '-';
}

/**
 * Pure display model for an inventory experiment snapshot
 * (`{ target: { stock, reservations, accepted }, ... }`, flat fallback).
 * Missing or malformed quantities render as '-'; nothing is invented as zero
 * and over-reservation is reported as-is (negative availability).
 */
export function extractInventorySnapshotDisplay(rawSnapshot: unknown): InventorySnapshotDisplay {
  const empty: InventorySnapshotDisplay = {
    stock: [], reservations: [], hasStock: false, hasReservations: false,
    stockAvailable: false, reservationsAvailable: false,
  };
  if (!isRecord(rawSnapshot)) return empty;
  const target = isRecord(rawSnapshot.target) ? rawSnapshot.target : rawSnapshot;

  const reservations: InventoryReservationDisplay[] = [];
  const reservationsRecord = isRecord(target.reservations) ? target.reservations : null;
  let unknownReservationSku = false;
  if (reservationsRecord) {
    for (const [reservationId, rawReservation] of Object.entries(reservationsRecord)) {
      const entry = isRecord(rawReservation) ? rawReservation : {};
      if (typeof entry.sku !== 'string' || !entry.sku || entry.sku.trim() !== entry.sku) {
        unknownReservationSku = true;
      }
      const sku = textOrDash(entry.sku);
      const quantity = finiteNumber(entry.quantity);
      const remaining = finiteNumber(entry.remaining);
      const shipped = finiteNumber(entry.shipped);
      const cancelled = finiteNumber(entry.cancelled);
      reservations.push({
        reservationId,
        sku,
        quantity,
        remaining,
        shipped,
        cancelled,
        displayText: `SKU: ${sku} | Quantity: ${quantity} | Remaining: ${remaining} | Shipped: ${shipped} | Cancelled: ${cancelled}`,
      });
    }
  }

  const stock: InventoryStockDisplay[] = [];
  const stockRecord = isRecord(target.stock) ? target.stock : null;
  if (stockRecord) {
    for (const [sku, rawStock] of Object.entries(stockRecord)) {
      const entry = isRecord(rawStock) ? rawStock : {};
      const received = finiteNumber(entry.received);
      const onHand = finiteNumber(entry.onHand);
      let reservedRemaining: number | '-' = '-';
      if (reservationsRecord && !unknownReservationSku) {
        let sum = 0;
        let malformed = false;
        for (const reservation of reservations) {
          if (reservation.sku !== sku) continue;
          if (reservation.remaining === '-' || !Number.isSafeInteger(reservation.remaining)) { malformed = true; break; }
          sum += reservation.remaining;
          if (!Number.isSafeInteger(sum)) { malformed = true; break; }
        }
        if (!malformed) reservedRemaining = sum;
      }
      const difference = onHand !== '-' && reservedRemaining !== '-' && Number.isSafeInteger(onHand)
        ? onHand - reservedRemaining : NaN;
      const available: number | '-' = Number.isSafeInteger(difference) ? difference : '-';
      const overReserved = available !== '-' && available < 0;
      const parts = [
        `Received: ${received}`,
        `On hand: ${onHand}`,
        `Reserved (remaining): ${reservedRemaining}`,
        `Available: ${available}`,
      ];
      if (overReserved) parts.push('Over-reserved');
      stock.push({ sku, received, onHand, reservedRemaining, available, overReserved, displayText: parts.join(' | ') });
    }
  }

  return {
    stock, reservations, hasStock: stock.length > 0, hasReservations: reservations.length > 0,
    stockAvailable: stockRecord !== null, reservationsAvailable: reservationsRecord !== null,
  };
}
