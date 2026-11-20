const monthFormat = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit'
});
export function stocktakeMonth(date = new Date()) {
  const parts = Object.fromEntries(monthFormat.formatToParts(date).map(p => [p.type, p.value]));
  return parts.year + '-' + parts.month;
}

export function savePhysicalLot(store, lot, actor, options, need) {
  const prior = store.get('lot', lot.id);
  const previouslyFlagged = prior?.owner === 'consignment' && prior.packaging === 'flagged';
  const flagged = lot.owner === 'consignment' && lot.packaging === 'flagged';
  const month = stocktakeMonth(new Date(lot.updatedAt));
  if (options.month !== undefined) {
    need(options.month === month, 'The stocktake month changed. Reopen the current month.', 409);
    need(lot.owner === 'consignment' && (!prior || prior.owner === 'consignment'),
      'This lot is no longer consignment stock. Refresh the stocktake.', 409);
  }
  if (prior?.storeStockAt) {
    need(lot.owner === 'owned', 'This pallet was already transferred to store stock.', 409);
    lot.storeStockAt = prior.storeStockAt;
    lot.originalSheets = prior.originalSheets;
  }
  if (prior?.openedAt) lot.openedAt = prior.openedAt;
  if (previouslyFlagged) need(flagged, 'Use the remaining sheet count to classify this flagged pallet.', 409);
  if (flagged) {
    const sealedBalance = previouslyFlagged && !prior.opened && prior.sheets > 0 ? prior.sheets : null;
    const original = prior?.originalSheets ?? sealedBalance ?? options.originalSheets ?? (!lot.opened ? lot.sheets : null);
    // Older clients can record an already-open pallet without knowing its delivered size.
    // Preserve that measurement and require the full size on its first stocktake or subsequent use.
    if (original == null && !prior && options.month === undefined && lot.opened) {
      lot.openedAt = lot.updatedAt;
      store.put('consignmentOpening', {id: lot.id, stock: lot.stock, location: lot.location,
        at: lot.updatedAt, month, actor: actor.id, previouslyOpen: true});
      return store.put('lot', lot);
    }
    need(Number.isSafeInteger(original) && original > 0 && original <= 99999999,
      'Enter the original full-pallet quantity in Recount before using this pallet.', 409);
    need(lot.sheets <= original, 'Remaining sheets exceed the original full-pallet quantity.', 409);
    need(lot.opened || (!prior?.opened && original === lot.sheets),
      'Confirm the pallet is open when its remaining quantity is below full.', 409);
    lot.originalSheets = original;
    if (lot.opened && !lot.openedAt) {
      lot.openedAt = lot.updatedAt;
      store.put('consignmentOpening', {id: lot.id, stock: lot.stock, location: lot.location,
        at: lot.updatedAt, month, actor: actor.id, previouslyOpen: prior?.opened === true});
    }
    if (lot.opened && lot.sheets * 2 <= original) {
      lot.owner = 'owned';
      lot.storeStockAt = lot.updatedAt;
      store.put('consignmentTransfer', {id: lot.id, stock: lot.stock, location: lot.location,
        originalSheets: original, sheets: lot.sheets, month, at: lot.updatedAt, actor: actor.id});
    }
  }
  if (options.month !== undefined) {
    store.put('consignmentCount', {id: JSON.stringify([month, lot.id]), lot: lot.id, stock: lot.stock,
      month, location: lot.location, sheets: lot.sheets, owner: lot.owner, opened: lot.opened,
      packaging: lot.packaging, actor: actor.id, at: lot.updatedAt});
  }
  return store.put('lot', lot);
}
