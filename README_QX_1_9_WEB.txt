QuickX Web 1.10 Beta v0.6 — Inventory Adjust SQL + Location Fix
====================================================================

PRODUCT BRANCH
- This is QX WEB only.
- Do not replace or modify QX 1.9 Final Chrome Extension with these files.
- Base used: QX Web 1.10 Beta v0.6 Inventory Adjust SQL + Location Fix.

STARTING THE HOST
1. Keep the whole extracted folder together on the host PC.
2. Stop the old QX Web PowerShell window.
3. Run START_QX_WEB.bat.
4. Verify:
     http://HOST-PC-IP:8080/api/health
   The version should be:
     QX Web 1.10 Beta v0.5 Adjust Out Location Restore
5. Other Quickmill users open:
     http://HOST-PC-IP:8080/

ARCHITECTURE
- Browser -> QX Web host on the PC.
- /api/* -> read-only VISUAL SQL queries.
- /rf/* -> RF Plus API proxy.
- All inventory and PO changes continue through RF Plus APIs.
- No SQL INSERT, UPDATE, DELETE, or MERGE statements are used.
- User RF Plus auth remains isolated in the browser tab/session.


QX WEB 1.10 BETA V0.6 — INVENTORY ADJUST SQL + LOCATION FIX
================================================================
- Adjust Out now reads part details and actual available stock locations from the
  existing read-only /api/inventory-adjust/part SQL endpoint.
- Adjust Out and Adjust In use separate location resolvers.
- Adjust Out shows only active, unlocked, non-transit, non-HOLD locations where
  AvailableQty is greater than zero. One location auto-selects; multiple locations
  require the operator to choose. Primary location is yellow visual information only.
- Adjust In still defaults to SQL PART_SITE.PRIMARY_LOC_ID, but the operator may type
  or select another destination. RF Plus validates or creates that part/location.
- Primary badges were removed from single and mass adjustment views.
- Mass Adjust Out uses actual stocked SQL locations. Mass Adjust In uses SQL primary
  only when a pasted row does not provide a destination.
- SQL remains read-only. Adjust Out and Adjust In continue through RF Plus APIs.


QX WEB 1.10 BETA V0.5 — ADJUST OUT LOCATION RESTORE
================================================================
- Adjust In now reads the primary destination from dbo.PART_SITE.PRIMARY_LOC_ID,
  selecting the PART_SITE row through QMIL's dbo.WAREHOUSE.SITE_ID.
- Zero-stock primary destinations remain valid for Adjust In.
- Mass Adjust In resolves all unique Part IDs through one parameterized batch SQL
  request instead of one SQL request per row.
- Adjust Out remains stock-location based; primary is visual reference only.
- PO Receiving Description Keyword now matches Description OR Vendor Part ID OR
  dbo.PART.MFG_PART_ID. Manufacturer part data remains hidden in the table.

QX WEB 1.10 BETA V0.3 — SMALL UI + PRIMARY LOCATION UPDATE
================================================================
- Top-right connected status label now displays RF Plus.
- Inventory Adjust button colors use the established QX cyan/green/red/neutral hierarchy.
- Primary locations are shown in yellow with a Primary badge in single and mass views.
- Mass paste areas use a dark background, full-strength pasted text and 60% placeholder text.
- Adjust In automatically selects a valid PRIMARY_LOC_ID when Location is omitted.
- An Excel-supplied location always overrides automatic primary selection.
- Missing, inactive, HOLD or RF Plus-rejected primary destinations remain Needs Location.
- SQL remains read-only and every inventory transaction continues through RF Plus.

NEW: INVENTORY ADJUST
- Navigation now shows Inventory Adjust.
- One native module contains Adjust Out and Adjust In modes.
- Existing Adjust Out and Mass Adjust Out remain available.
- Adjust In official RF Plus endpoint:
    POST /api/inventoryAdjust/InventoryAdjustIn
- Adjust In payload:
    partId, traceId, qty, warehouseId, locationId,
    transactionDescription, reason
- Default Adjust In values:
    Transaction Description = Manual / other...
    Reason = 5556 (INVENTORY ADJUST)
- Destination locations are suggested by read-only SQL and then validated by RF Plus.
- New part/location status uses RF Plus Available / Unavailable / Hold selection.
- Mass Adjust In accepts:
    Part ID | Qty | optional Location | optional Trace
- Identical submissions are blocked for 15 seconds.

NEW: PO RECEIVING VENDOR SEARCH
- Search By selector supports PO Number or Vendor.
- Vendor search accepts Vendor ID, Vendor Name, or partial Vendor Name.
- Results contain only Released POs with remaining open quantity.
- Selecting a result loads the existing PO Receiving workflow; no second receiving screen exists.

KNOWN LIMITATIONS
- No live production Adjust In was submitted during build testing.
- Parts requiring interactive RF Plus trace-profile fields stop with a clear error and must
  be adjusted in RF Plus until those dynamic fields are added to QX Web.
- Project-warehouse/WBS Adjust In fields are not exposed in this QMIL-focused build.
- Vendor Name search uses dbo.VENDOR.ID / dbo.VENDOR.NAME. If this VISUAL schema differs,
  QX automatically falls back to Vendor ID search and shows a warning.
- PART.PRIMARY_LOC_ID is used when available. If that column is not available in the live
  schema, QX falls back to active CR_PART_LOCATION suggestions; RF Plus still performs the
  final destination validation.

SAFE ACCEPTANCE TEST
1. Keep QX Web 1.9.2 as rollback.
2. Start this beta on the host.
3. Test one existing Adjust Out.
4. Test one small Adjust In for a normal non-traceable part and known location.
5. Verify inventory in VISUAL/RF Plus.
6. Test one Mass Adjust In row before a larger batch.
7. Search a known vendor and load one result into PO Receiving.
8. Test PO Receiving separately with a small known PO action.

QX WEB 1.10 BETA V0.2 — ONE-CLICK LAN START
===========================================
Do not run a separate LAN hosting installer. Double-click START_QX_WEB.bat.
The BAT now checks and installs its own HTTP URL reservation and LocalSubnet
Windows Firewall rule for TCP port 8080. First run requests Administrator
approval automatically and then starts the server. The window displays the
exact link to use from other Quickmill computers.

QX WEB 1.10 BETA V0.5 — ADJUST OUT LOCATION RESTORE
----------------------------------------------------
- Restores the proven QX Web 1.9.2 RF Plus stock-location response parser for
  Single and Mass Adjust Out.
- Adjust Out uses only actual locations with positive available stock.
- PRIMARY_LOC_ID remains a yellow visual reference only for Adjust Out.
- Adjust In SQL primary-destination logic is unchanged.
