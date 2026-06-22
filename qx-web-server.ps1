# QX Web Server (QX 1.9 Web) — all-in-one for hosting QuickX from your PC.
# Serves the QuickX website + proxies RF Plus + serves the SQL read bridge, all on
# ONE origin so browsers (which can't call RF Plus cross-origin) work through this PC.
#
#   User browser  ->  THIS PC (website + /rf proxy + /api bridge)  ->  RF Plus :9001 / :9000
#                                                                  ->  VISUAL4.qm.local (QM DB)
#
# Others open:  http://<this-pc-ip>:8080/   (sign in with their own RF Plus user id+password)
# SECURITY: bound to all interfaces and open to the LAN by request. Anyone who can
# reach this PC's IP can use RF Plus via the proxy and read QM via the bridge.

param(
    [string]$Server = "VISUAL4.qm.local",
    [string]$Database = "QM",
    [string]$Prefix = "http://+:8080/",
    [string]$WebRoot = "",
    [string]$RfBase = "http://192.168.88.142:9001",
    [string]$Rf9000Base = "http://192.168.88.142:9000"
)

$ErrorActionPreference = "Stop"

# QX Web: default the website root to the folder this script sits in (the QuickX files).
if ([string]::IsNullOrWhiteSpace($WebRoot)) {
    $WebRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

Add-Type -AssemblyName System.Web
Add-Type -AssemblyName System.Data

$connString = "Server=$Server;Database=$Database;Integrated Security=True;TrustServerCertificate=True;Connection Timeout=10;"

function Write-Log($msg) {
    Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg)
}

function Convert-TableToObjects([System.Data.DataTable]$table) {
    $rows = @()
    foreach ($row in $table.Rows) {
        $obj = [ordered]@{}
        foreach ($col in $table.Columns) {
            $val = $row[$col.ColumnName]
            if ($val -eq [DBNull]::Value) { $val = $null }
            $obj[$col.ColumnName] = $val
        }
        $rows += [pscustomobject]$obj
    }
    return $rows
}

function Invoke-QxQuery($conn, [string]$sql, [string]$partId) {
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    $cmd.Parameters.Add("@PartID", [System.Data.SqlDbType]::NVarChar, 80).Value = $partId
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $table = New-Object System.Data.DataTable
    [void]$adapter.Fill($table)
    return Convert-TableToObjects $table
}

function Invoke-QxQueryParams($conn, [string]$sql, [hashtable]$params) {
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    foreach ($k in $params.Keys) {
        $val = $params[$k]
        if ($null -eq $val) { $val = "" }
        [void]$cmd.Parameters.Add($k, [System.Data.SqlDbType]::NVarChar, 120)
        $cmd.Parameters[$k].Value = [string]$val
    }
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $table = New-Object System.Data.DataTable
    [void]$adapter.Fill($table)
    return Convert-TableToObjects $table
}

function Clean-QxId([string]$v) {
    if ($null -eq $v) { return "" }
    return (($v -replace "[^A-Za-z0-9_\-\.\/ ]", "").Trim().ToUpperInvariant())
}

function Get-PartLookup([string]$partId) {
    $partId = ($partId -replace "[^A-Za-z0-9_\-\.\/ ]", "").Trim().ToUpperInvariant()
    if ([string]::IsNullOrWhiteSpace($partId)) { throw "Missing partId." }

    $conn = New-Object System.Data.SqlClient.SqlConnection $connString
    $conn.Open()
    try {
        $part = Invoke-QxQuery $conn @"
SELECT TOP 1
    ID,
    DESCRIPTION,
    STOCK_UM,
    PRODUCT_CODE,
    COMMODITY_CODE,
    FABRICATED,
    PURCHASED,
    STOCKED,
    STATUS,
    USER_9,
    LTRIM(RTRIM(ISNULL(USER_9, ''))) AS PART_USER_9,
    LTRIM(RTRIM(ISNULL(USER_9, ''))) AS KANBAN,
    LTRIM(RTRIM(ISNULL(USER_9, ''))) AS KANBAN_VALUE
FROM dbo.PART
WHERE ID = @PartID;
"@ $partId

        $stock = Invoke-QxQuery $conn @"
SELECT
    ID AS PART_ID,
    WAREHOUSE_ID,
    LOCATION_ID,
    QTY,
    COMMITTED_QTY,
    (QTY - ISNULL(COMMITTED_QTY,0)) AS AVAILABLE_QTY,
    STATUS,
    LOCKED,
    HOLD_REASON_ID,
    TRANSIT,
    CASE
        WHEN WAREHOUSE_ID = 'QMIL'
         AND STATUS = 'A'
         AND LOCKED = 'N'
         AND TRANSIT = 'N'
         AND LOCATION_ID <> 'HOLD'
         AND (QTY - ISNULL(COMMITTED_QTY,0)) > 0
        THEN 1 ELSE 0
    END AS USABLE_FOR_ISSUE
FROM dbo.CR_PART_LOCATION
WHERE ID = @PartID
  AND WAREHOUSE_ID = 'QMIL'
ORDER BY USABLE_FOR_ISSUE DESC, LOCATION_ID;
"@ $partId

        $demand = Invoke-QxQuery $conn @"
SELECT TOP 200
    r.WORKORDER_BASE_ID,
    r.WORKORDER_LOT_ID,
    r.WORKORDER_SPLIT_ID,
    r.WORKORDER_SUB_ID,
    w.STATUS AS WO_STATUS,
    r.OPERATION_SEQ_NO,
    r.PIECE_NO,
    r.ID AS PART_ID,
    p.DESCRIPTION,
    r.STATUS AS REQ_STATUS,
    r.CALC_QTY,
    r.ISSUED_QTY,
    (ISNULL(r.CALC_QTY,0) - ISNULL(r.ISSUED_QTY,0)) AS REMAINING_QTY,
    r.REQUIRED_DATE
FROM dbo.CR_PART_REQ r
JOIN dbo.WORK_ORDER w
    ON w.TYPE = r.WORKORDER_TYPE
    AND w.BASE_ID = r.WORKORDER_BASE_ID
    AND w.LOT_ID = r.WORKORDER_LOT_ID
    AND w.SPLIT_ID = r.WORKORDER_SPLIT_ID
    AND w.SUB_ID = r.WORKORDER_SUB_ID
LEFT JOIN dbo.PART p
    ON p.ID = r.ID
WHERE r.ID = @PartID
  AND w.STATUS IN ('F','R')
  AND r.STATUS IN ('F','R')
  AND (ISNULL(r.CALC_QTY,0) - ISNULL(r.ISSUED_QTY,0)) > 0
ORDER BY r.WORKORDER_BASE_ID, r.WORKORDER_SUB_ID, r.OPERATION_SEQ_NO, r.PIECE_NO;
"@ $partId

        # Issued / Returnable: IMPORTANT — filter only WO status F/R.
        # Do NOT filter requirement status F/R, because fully issued requirement rows may
        # change req status while the WO is still Firm/Released.
        $issued = Invoke-QxQuery $conn @"
SELECT TOP 500
    r.WORKORDER_BASE_ID AS WOId,
    r.WORKORDER_LOT_ID AS LotId,
    r.WORKORDER_SPLIT_ID AS SplitId,
    r.WORKORDER_SUB_ID AS SubId,
    r.ID AS PartId,
    p.DESCRIPTION AS [Desc],
    p.STOCK_UM AS Uom,
    r.CALC_QTY AS CalculatedQty,
    r.ISSUED_QTY AS IssuedQty,
    (ISNULL(r.CALC_QTY,0) - ISNULL(r.ISSUED_QTY,0)) AS NeedQty,
    r.ISSUED_QTY AS ReturnQty,
    ISNULL(r.LOCATION_ID, '') AS PartPrimaryLocID,
    ISNULL(r.LOCATION_ID, '') AS LOCATION_ID,
    ISNULL(r.WAREHOUSE_ID, 'QMIL') AS WAREHOUSE_ID,
    r.OPERATION_SEQ_NO AS SeqNo,
    r.PIECE_NO AS PieceNo,
    w.STATUS AS WOStatus,
    r.STATUS AS ReqStatus,
    r.REQUIRED_DATE AS RequiredDate
FROM dbo.CR_PART_REQ r
JOIN dbo.WORK_ORDER w
    ON w.TYPE = r.WORKORDER_TYPE
    AND w.BASE_ID = r.WORKORDER_BASE_ID
    AND w.LOT_ID = r.WORKORDER_LOT_ID
    AND w.SPLIT_ID = r.WORKORDER_SPLIT_ID
    AND w.SUB_ID = r.WORKORDER_SUB_ID
LEFT JOIN dbo.PART p
    ON p.ID = r.ID
WHERE r.ID = @PartID
  AND w.STATUS IN ('F','R')
  AND ISNULL(r.ISSUED_QTY,0) > 0
ORDER BY r.WORKORDER_BASE_ID, r.WORKORDER_SUB_ID, r.OPERATION_SEQ_NO, r.PIECE_NO;
"@ $partId

        # Incoming / Open PO: use QUICKMILL view for correct open PO rows.
        # Keep this as the proven v0.1 query. UI formats DESIRED_RECV_DATE as Due Date.
        $po = Invoke-QxQuery $conn @"
SELECT TOP 200
    q.PURC_ORDER_ID,
    q.LINE_NO,
    q.PART_ID,
    q.VENDOR_PART_ID,
    q.ORDER_QTY,
    q.TOTAL_RECEIVED_QTY,
    (q.ORDER_QTY - q.TOTAL_RECEIVED_QTY) AS OPEN_QTY,
    q.UNIT_PRICE,
    q.PRODUCT_CODE,
    q.COMMODITY_CODE,
    q.VENDOR_ID,
    q.DESIRED_RECV_DATE,
    ISNULL((
        SELECT TOP (1) COALESCE(NULLIF(d.[USER_1], ''), NULLIF(l.[USER_1], ''), '')
        FROM [dbo].[PURC_ORDER_LINE] AS l
        LEFT JOIN [dbo].[PURC_LINE_DEL] AS d
            ON d.[PURC_ORDER_ID] = l.[PURC_ORDER_ID]
           AND d.[PURC_ORDER_LINE_NO] = l.[LINE_NO]
        WHERE l.[PURC_ORDER_ID] = q.[PURC_ORDER_ID]
          AND l.[LINE_NO] = q.[LINE_NO]
    ), '') AS UserDefined1
FROM dbo.QUICKMILL_PURCHASEORDERS q
WHERE q.PART_ID = @PartID
  AND (q.ORDER_QTY - q.TOTAL_RECEIVED_QTY) > 0
ORDER BY q.DESIRED_RECV_DATE, q.PURC_ORDER_ID, q.LINE_NO;
"@ $partId

        $kanbanValue = ''
        if (@($part).Count -gt 0) {
            try { $kanbanValue = [string]($part[0].KANBAN_VALUE) } catch {}
            if ([string]::IsNullOrWhiteSpace($kanbanValue)) {
                try { $kanbanValue = [string]($part[0].USER_9) } catch {}
            }
        }
        $kanbanValue = $kanbanValue.Trim()

        $usableStock = @($stock | Where-Object { $_.USABLE_FOR_ISSUE -eq 1 })
        $totalAvailable = 0
        foreach ($s in $stock) { $totalAvailable += [decimal]($s.AVAILABLE_QTY) }
        $totalUsable = 0
        foreach ($s in $usableStock) { $totalUsable += [decimal]($s.AVAILABLE_QTY) }
        $totalDemand = 0
        foreach ($d in $demand) { $totalDemand += [decimal]($d.REMAINING_QTY) }
        $totalIssued = 0
        foreach ($ir in $issued) { $totalIssued += [decimal]($ir.IssuedQty) }
        $totalOpenPO = 0
        foreach ($p in $po) { $totalOpenPO += [decimal]($p.OPEN_QTY) }

        return [ordered]@{
            ok = $true
            server = $Server
            database = $Database
            bridgeVersion = "QX Web 1.10 Beta v0.6 Inventory Adjust SQL + Location Fix"
            kanbanSource = "QM.dbo.PART.USER_9"
            partId = $partId
            generatedAt = (Get-Date).ToString("s")
            summary = [ordered]@{
                partFound = (@($part).Count -gt 0)
                kanbanValue = $kanbanValue
                isKanban = @('YES','Y','TRUE','1','KANBAN') -contains $kanbanValue.ToUpperInvariant()
                stockLocations = @($stock).Count
                totalAvailableQty = $totalAvailable
                usableStockLocations = @($usableStock).Count
                totalUsableQty = $totalUsable
                activeDemandRows = @($demand).Count
                totalDemandQty = $totalDemand
                issuedReturnableRows = @($issued).Count
                totalIssuedQty = $totalIssued
                openPORows = @($po).Count
                totalOpenPOQty = $totalOpenPO
            }
            kanbanValue = $kanbanValue
            isKanban = @('YES','Y','TRUE','1','KANBAN') -contains $kanbanValue.ToUpperInvariant()
            part = @($part)
            stock = @($stock)
            demand = @($demand)
            issued = @($issued)
            returnable = @($issued)
            purchaseOrders = @($po)
        }
    }
    finally {
        $conn.Close()
    }
}


function Get-WOListSql([string]$woId) {
    $woId = Clean-QxId $woId
    if ([string]::IsNullOrWhiteSpace($woId)) { throw "Missing woId." }
    $conn = New-Object System.Data.SqlClient.SqlConnection $connString
    $conn.Open()
    try {
        $rows = Invoke-QxQueryParams $conn @"
SELECT
    BASE_ID AS WOId,
    LOT_ID AS LotId,
    SPLIT_ID AS SplitId,
    SUB_ID AS SubId,
    STATUS AS Status,
    PART_ID AS PartId
FROM dbo.WORK_ORDER
WHERE BASE_ID = @WOID
ORDER BY LOT_ID, SPLIT_ID, SUB_ID;
"@ @{ "@WOID" = $woId }
        return [ordered]@{
            ok = $true
            bridgeVersion = "QX Web 1.10 Beta v0.6 Inventory Adjust SQL + Location Fix"
            readSource = "SQL dbo.WORK_ORDER"
            WOId = $woId
            rows = @($rows)
            generatedAt = (Get-Date).ToString("s")
        }
    }
    finally { $conn.Close() }
}

function Get-WORequirementsSql([string]$woId, [string]$lotId, [string]$splitId, [string]$subId) {
    $woId = Clean-QxId $woId
    $lotId = Clean-QxId $lotId
    $splitId = Clean-QxId $splitId
    $subId = Clean-QxId $subId
    if ([string]::IsNullOrWhiteSpace($woId)) { throw "Missing woId." }

    $conn = New-Object System.Data.SqlClient.SqlConnection $connString
    $conn.Open()
    try {
        $rows = Invoke-QxQueryParams $conn @"
SELECT TOP 2000
    r.WORKORDER_BASE_ID AS WOId,
    r.WORKORDER_LOT_ID AS LotId,
    r.WORKORDER_SPLIT_ID AS SplitId,
    r.WORKORDER_SUB_ID AS SubId,
    r.ID AS PartId,
    p.DESCRIPTION AS [Desc],
    p.STOCK_UM AS Uom,
    r.CALC_QTY AS CalculatedQty,
    r.ISSUED_QTY AS IssuedQty,
    (ISNULL(r.CALC_QTY,0) - ISNULL(r.ISSUED_QTY,0)) AS NeedQty,
    ISNULL((
        SELECT SUM(ISNULL(pl.QTY,0) - ISNULL(pl.COMMITTED_QTY,0))
        FROM dbo.CR_PART_LOCATION pl
        WHERE pl.ID = r.ID
          AND pl.WAREHOUSE_ID = 'QMIL'
          AND pl.STATUS = 'A'
          AND pl.LOCKED = 'N'
          AND pl.TRANSIT = 'N'
          AND pl.LOCATION_ID <> 'HOLD'
    ),0) AS InvPartQty,
    ISNULL((
        SELECT TOP 1 pl.LOCATION_ID
        FROM dbo.CR_PART_LOCATION pl
        WHERE pl.ID = r.ID
          AND pl.WAREHOUSE_ID = 'QMIL'
          AND pl.STATUS = 'A'
          AND pl.LOCKED = 'N'
          AND pl.TRANSIT = 'N'
          AND pl.LOCATION_ID <> 'HOLD'
          AND (ISNULL(pl.QTY,0) - ISNULL(pl.COMMITTED_QTY,0)) > 0
        ORDER BY (ISNULL(pl.QTY,0) - ISNULL(pl.COMMITTED_QTY,0)) DESC, pl.LOCATION_ID
    ),'') AS PartPrimaryLocID,
    ISNULL(STUFF((
        SELECT '|' + pl.LOCATION_ID + ':' + CONVERT(varchar(40), CAST((ISNULL(pl.QTY,0) - ISNULL(pl.COMMITTED_QTY,0)) AS decimal(18,3)))
        FROM dbo.CR_PART_LOCATION pl
        WHERE pl.ID = r.ID
          AND pl.WAREHOUSE_ID = 'QMIL'
          AND pl.STATUS = 'A'
          AND pl.LOCKED = 'N'
          AND pl.TRANSIT = 'N'
          AND pl.LOCATION_ID <> 'HOLD'
          AND (ISNULL(pl.QTY,0) - ISNULL(pl.COMMITTED_QTY,0)) > 0
        ORDER BY (ISNULL(pl.QTY,0) - ISNULL(pl.COMMITTED_QTY,0)) DESC, pl.LOCATION_ID
        FOR XML PATH(''), TYPE
    ).value('.', 'nvarchar(max)'), 1, 1, ''),'') AS QXIssueLocList,
    r.OPERATION_SEQ_NO AS SeqNo,
    r.PIECE_NO AS PieceNo,
    w.STATUS AS WOStatus,
    r.STATUS AS ReqStatus,
    r.REQUIRED_DATE AS RequiredDate,
    'SQL' AS Source
FROM dbo.CR_PART_REQ r
JOIN dbo.WORK_ORDER w
    ON w.TYPE = r.WORKORDER_TYPE
    AND w.BASE_ID = r.WORKORDER_BASE_ID
    AND w.LOT_ID = r.WORKORDER_LOT_ID
    AND w.SPLIT_ID = r.WORKORDER_SPLIT_ID
    AND w.SUB_ID = r.WORKORDER_SUB_ID
LEFT JOIN dbo.PART p ON p.ID = r.ID
WHERE r.WORKORDER_BASE_ID = @WOID
  AND (@LOTID = '' OR r.WORKORDER_LOT_ID = @LOTID)
  AND (@SPLITID = '' OR r.WORKORDER_SPLIT_ID = @SPLITID)
  AND (@SUBID = '' OR r.WORKORDER_SUB_ID = @SUBID)
ORDER BY r.WORKORDER_SUB_ID, r.OPERATION_SEQ_NO, r.PIECE_NO;
"@ @{ "@WOID" = $woId; "@LOTID" = $lotId; "@SPLITID" = $splitId; "@SUBID" = $subId }

        $need = 0
        $issued = 0
        foreach ($r in $rows) {
            $need += [decimal]($r.NeedQty)
            $issued += [decimal]($r.IssuedQty)
        }

        return [ordered]@{
            ok = $true
            bridgeVersion = "QX Web 1.10 Beta v0.6 Inventory Adjust SQL + Location Fix"
            readSource = "SQL dbo.CR_PART_REQ + dbo.WORK_ORDER + dbo.CR_PART_LOCATION"
            WOId = $woId
            lotId = $lotId
            splitId = $splitId
            subId = $subId
            summary = [ordered]@{
                rows = @($rows).Count
                totalNeedQty = $need
                totalIssuedQty = $issued
            }
            rows = @($rows)
            generatedAt = (Get-Date).ToString("s")
        }
    }
    finally { $conn.Close() }
}


function Get-POReceivingSql([string]$poId) {
    $poId = Clean-QxId $poId
    if ([string]::IsNullOrWhiteSpace($poId)) { throw "Missing poId." }

    $conn = New-Object System.Data.SqlClient.SqlConnection $connString
    $conn.Open()
    try {
        $header = Invoke-QxQueryParams $conn @"
SELECT TOP (1)
    h.[ID] AS [POId],
    h.[VENDOR_ID] AS [VendorId],
    h.[ORDER_DATE] AS [OrderDate],
    h.[DESIRED_RECV_DATE] AS [DesiredRecvDate],
    h.[PROMISE_DATE] AS [PromiseDate],
    h.[WAREHOUSE_ID] AS [WarehouseId],
    h.[STATUS] AS [Status],
    h.[TOTAL_AMT_ORDERED] AS [TotalAmountOrdered],
    h.[TOTAL_AMT_RECVD] AS [TotalAmountReceived]
FROM [dbo].[PURCHASE_ORDER] AS h
WHERE h.[ID] = @POID;
"@ @{ "@POID" = $poId }

        $lines = Invoke-QxQueryParams $conn @"
SELECT
    l.[PURC_ORDER_ID] AS [POId],
    l.[LINE_NO] AS [LineNo],
    d.[DEL_SCHED_LINE_NO] AS [DeliveryLineNo],
    ISNULL(l.[PART_ID], '') AS [PartId],
    ISNULL(l.[VENDOR_PART_ID], '') AS [VendorPartID],
    ISNULL(p.[MFG_PART_ID], '') AS [MfgPartID],
    COALESCE(p.[DESCRIPTION], NULLIF(l.[SERVICE_ID], ''), NULLIF(l.[VENDOR_PART_ID], ''), '') AS [Description],
    COALESCE(d.[ORDER_QTY], l.[ORDER_QTY], CONVERT(decimal(18,4),0)) AS [OrderQty],
    COALESCE(d.[RECEIVED_QTY], l.[TOTAL_RECEIVED_QTY], CONVERT(decimal(18,4),0)) AS [ReceivedQty],
    (COALESCE(d.[ORDER_QTY], l.[ORDER_QTY], CONVERT(decimal(18,4),0)) - COALESCE(d.[RECEIVED_QTY], l.[TOTAL_RECEIVED_QTY], CONVERT(decimal(18,4),0))) AS [OpenQty],
    l.[PURCHASE_UM] AS [UOM],
    l.[LINE_STATUS] AS [LineStatus],
    l.[PRODUCT_CODE] AS [ProductCode],
    l.[COMMODITY_CODE] AS [CommodityCode],
    COALESCE(d.[WAREHOUSE_ID], l.[WAREHOUSE_ID], h.[WAREHOUSE_ID], 'QMIL') AS [WarehouseId],
    CASE
      WHEN NULLIF(LTRIM(RTRIM(ISNULL(l.[PART_ID], ''))), '') IS NULL THEN 'RECV'
      ELSE ISNULL((
          SELECT MIN(pl.[LOCATION_ID])
          FROM [dbo].[CR_PART_LOCATION] AS pl
          WHERE pl.[ID] = l.[PART_ID]
            AND pl.[WAREHOUSE_ID] = 'QMIL'
            AND pl.[STATUS] = 'A'
            AND pl.[LOCKED] = 'N'
            AND pl.[TRANSIT] = 'N'
            AND pl.[LOCATION_ID] <> 'HOLD'
            AND (ISNULL(pl.[QTY],0)-ISNULL(pl.[COMMITTED_QTY],0)) > 0
      ), ISNULL((
          SELECT MIN(pl2.[LOCATION_ID])
          FROM [dbo].[CR_PART_LOCATION] AS pl2
          WHERE pl2.[ID] = l.[PART_ID]
            AND pl2.[WAREHOUSE_ID] = 'QMIL'
            AND pl2.[STATUS] = 'A'
            AND pl2.[LOCKED] = 'N'
            AND pl2.[TRANSIT] = 'N'
            AND pl2.[LOCATION_ID] <> 'HOLD'
      ), ''))
    END AS [PrimaryLocID],
    COALESCE(NULLIF(d.[USER_1], ''), NULLIF(l.[USER_1], ''), '') AS [UserDefined1],
    l.[USER_1] AS [LineUser1],
    d.[USER_1] AS [DeliveryUser1],
    l.[DESIRED_RECV_DATE] AS [LineDesiredRecvDate],
    d.[DESIRED_RECV_DATE] AS [DeliveryDesiredRecvDate],
    l.[PROMISE_DATE] AS [PromiseDate],
    CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(l.[PART_ID], ''))), '') IS NULL THEN 1 ELSE 0 END AS [IsNullPartLine]
FROM [dbo].[PURC_ORDER_LINE] AS l
INNER JOIN [dbo].[PURCHASE_ORDER] AS h ON h.[ID] = l.[PURC_ORDER_ID]
LEFT JOIN [dbo].[PART] AS p ON p.[ID] = l.[PART_ID]
LEFT JOIN [dbo].[PURC_LINE_DEL] AS d
    ON d.[PURC_ORDER_ID] = l.[PURC_ORDER_ID]
   AND d.[PURC_ORDER_LINE_NO] = l.[LINE_NO]
WHERE l.[PURC_ORDER_ID] = @POID
ORDER BY l.[LINE_NO], d.[DEL_SCHED_LINE_NO];
"@ @{ "@POID" = $poId }

        $openQty = 0
        foreach ($l in $lines) { $openQty += [decimal]($l.OpenQty) }
        return [ordered]@{
            ok = $true
            bridgeVersion = "QX Web 1.10 Beta v0.6 Inventory Adjust SQL + Location Fix"
            readSource = "SQL dbo.PURCHASE_ORDER + dbo.PURC_ORDER_LINE.VENDOR_PART_ID + dbo.PART.MFG_PART_ID + dbo.PURC_LINE_DEL"
            POId = $poId
            header = @($header)
            summary = [ordered]@{
                lines = @($lines).Count
                openQty = $openQty
            }
            lines = @($lines)
            generatedAt = (Get-Date).ToString("s")
        }
    }
    finally { $conn.Close() }
}


function Get-InventoryAdjustPartSql([string]$partId, [string]$warehouseId = 'QMIL') {
    $partId = Clean-QxId $partId
    $warehouseId = Clean-QxId $warehouseId
    if ([string]::IsNullOrWhiteSpace($partId)) { throw "Missing partId." }
    if ([string]::IsNullOrWhiteSpace($warehouseId)) { $warehouseId = 'QMIL' }

    $conn = New-Object System.Data.SqlClient.SqlConnection $connString
    $conn.Open()
    try {
        # RF Plus / VISUAL source of truth for a site's primary location is
        # PART_SITE.PRIMARY_LOC_ID. The correct PART_SITE row is selected through
        # the login warehouse's WAREHOUSE.SITE_ID, not from current stock rows.
        $part = Invoke-QxQueryParams $conn @"
SELECT TOP (1)
    p.[ID] AS [PartId],
    ISNULL(p.[DESCRIPTION], '') AS [Description],
    ISNULL(p.[STOCK_UM], 'EA') AS [UOM],
    ISNULL(p.[STATUS], '') AS [PartStatus],
    ISNULL(ps.[PRIMARY_LOC_ID], '') AS [PrimaryLocID],
    ISNULL(ps.[PRIMARY_WHS_ID], '') AS [PrimaryWhsID],
    ISNULL(ps.[SITE_ID], '') AS [SiteID],
    CASE WHEN pl.[ID] IS NULL THEN 0 ELSE 1 END AS [PrimaryLocationExists],
    CASE
      WHEN NULLIF(LTRIM(RTRIM(ISNULL(ps.[PRIMARY_LOC_ID], ''))), '') IS NULL THEN 0
      WHEN UPPER(LTRIM(RTRIM(ISNULL(ps.[PRIMARY_LOC_ID], '')))) = 'HOLD' THEN 0
      WHEN pl.[ID] IS NULL THEN 1
      WHEN ISNULL(pl.[STATUS], '') = 'A'
       AND ISNULL(pl.[LOCKED], 'N') = 'N'
       AND ISNULL(pl.[TRANSIT], 'N') = 'N' THEN 1
      ELSE 0
    END AS [PrimaryLocationValid],
    ISNULL(pl.[QTY], 0) AS [PrimaryQty],
    ISNULL(pl.[COMMITTED_QTY], 0) AS [PrimaryCommittedQty],
    (ISNULL(pl.[QTY], 0) - ISNULL(pl.[COMMITTED_QTY], 0)) AS [PrimaryAvailableQty]
FROM [dbo].[PART] AS p
LEFT JOIN [dbo].[WAREHOUSE] AS w
  ON w.[ID] = @WarehouseID
LEFT JOIN [dbo].[PART_SITE] AS ps
  ON ps.[PART_ID] = p.[ID]
 AND ps.[SITE_ID] = w.[SITE_ID]
LEFT JOIN [dbo].[CR_PART_LOCATION] AS pl
  ON pl.[ID] = p.[ID]
 AND pl.[WAREHOUSE_ID] = @WarehouseID
 AND UPPER(LTRIM(RTRIM(ISNULL(pl.[LOCATION_ID], '')))) = UPPER(LTRIM(RTRIM(ISNULL(ps.[PRIMARY_LOC_ID], ''))))
WHERE p.[ID] = @PartID;
"@ @{ "@PartID" = $partId; "@WarehouseID" = $warehouseId }

        $locations = Invoke-QxQueryParams $conn @"
SELECT
    pl.[ID] AS [PartId],
    pl.[WAREHOUSE_ID] AS [WarehouseId],
    pl.[LOCATION_ID] AS [LocationId],
    ISNULL(pl.[QTY], 0) AS [Qty],
    ISNULL(pl.[COMMITTED_QTY], 0) AS [CommittedQty],
    (ISNULL(pl.[QTY], 0) - ISNULL(pl.[COMMITTED_QTY], 0)) AS [AvailableQty],
    ISNULL(pl.[STATUS], '') AS [LocationStatus],
    ISNULL(pl.[LOCKED], 'N') AS [Locked],
    ISNULL(pl.[TRANSIT], 'N') AS [Transit],
    ISNULL(pl.[HOLD_REASON_ID], '') AS [HoldReasonId]
FROM [dbo].[CR_PART_LOCATION] AS pl
WHERE pl.[ID] = @PartID
  AND pl.[WAREHOUSE_ID] = @WarehouseID
  AND ISNULL(pl.[STATUS], '') = 'A'
  AND ISNULL(pl.[LOCKED], 'N') = 'N'
  AND ISNULL(pl.[TRANSIT], 'N') = 'N'
  AND ISNULL(pl.[LOCATION_ID], '') <> ''
  AND UPPER(ISNULL(pl.[LOCATION_ID], '')) <> 'HOLD'
ORDER BY pl.[LOCATION_ID];
"@ @{ "@PartID" = $partId; "@WarehouseID" = $warehouseId }

        $primary = ''
        $primaryValid = $false
        $primaryExists = $false
        $primaryAvailable = 0
        if (@($part).Count -gt 0) {
            $row = @($part)[0]
            $primary = ([string]$row.PrimaryLocID).Trim().ToUpperInvariant()
            $primaryValid = ([int]$row.PrimaryLocationValid -eq 1)
            $primaryExists = ([int]$row.PrimaryLocationExists -eq 1)
            $primaryAvailable = [decimal]$row.PrimaryAvailableQty
        }

        $locRows = @()
        foreach ($r in @($locations)) {
            $locId = ([string]$r.LocationId).Trim().ToUpperInvariant()
            $locRows += [pscustomobject][ordered]@{
                PartId = $r.PartId
                WarehouseId = $r.WarehouseId
                LocationId = $locId
                Qty = $r.Qty
                CommittedQty = $r.CommittedQty
                AvailableQty = $r.AvailableQty
                LocationStatus = $r.LocationStatus
                Locked = $r.Locked
                Transit = $r.Transit
                HoldReasonId = $r.HoldReasonId
                IsPrimary = (-not [string]::IsNullOrWhiteSpace($primary) -and $locId -eq $primary)
                Source = 'CR_PART_LOCATION'
            }
        }

        # Adjust In may target a valid primary location even when that part/location
        # has no current inventory row. Add a zero-quantity suggestion sourced from
        # PART_SITE so the frontend can select it without treating it as stock.
        if ($primaryValid -and -not (@($locRows) | Where-Object { $_.LocationId -eq $primary })) {
            $locRows = @([pscustomobject][ordered]@{
                PartId = $partId
                WarehouseId = $warehouseId
                LocationId = $primary
                Qty = 0
                CommittedQty = 0
                AvailableQty = 0
                LocationStatus = 'A'
                Locked = 'N'
                Transit = 'N'
                HoldReasonId = ''
                IsPrimary = $true
                Source = 'PART_SITE.PRIMARY_LOC_ID'
            }) + @($locRows)
        }

        $lookupIssue = ''
        if (@($part).Count -eq 0) {
            $lookupIssue = 'Part ID was not found in dbo.PART.'
        }
        elseif ([string]::IsNullOrWhiteSpace($primary)) {
            $lookupIssue = 'PART_SITE.PRIMARY_LOC_ID was blank for the warehouse site.'
        }
        elseif (-not $primaryValid) {
            $lookupIssue = 'The SQL primary location exists but is inactive, locked, transit, or prohibited.'
        }

        $stockLocRows = @($locRows | Where-Object { [decimal]$_.AvailableQty -gt 0 })

        return [ordered]@{
            ok = $true
            readSource = 'SQL dbo.PART_SITE.PRIMARY_LOC_ID joined through dbo.WAREHOUSE.SITE_ID + dbo.CR_PART_LOCATION'
            primaryLocationSource = 'dbo.PART_SITE.PRIMARY_LOC_ID'
            warehouseId = $warehouseId
            partId = $partId
            part = @($part)
            primaryLocation = $primary
            primaryLocationValid = $primaryValid
            primaryLocationExists = $primaryExists
            primaryAvailableQty = $primaryAvailable
            primaryLookupIssue = $lookupIssue
            # Keep locations for compatibility. Mode-specific arrays prevent
            # Adjust Out stock rules from being mixed with Adjust In destinations.
            locations = @($locRows)
            stockLocations = @($stockLocRows)
            destinationLocations = @($locRows)
            generatedAt = (Get-Date).ToString('s')
        }
    }
    finally { $conn.Close() }
}

function Get-InventoryAdjustPrimaryLocationsSql([string[]]$partIds, [string]$warehouseId = 'QMIL') {
    $warehouseId = Clean-QxId $warehouseId
    if ([string]::IsNullOrWhiteSpace($warehouseId)) { $warehouseId = 'QMIL' }

    $clean = @()
    foreach ($id in @($partIds)) {
        $partKey = Clean-QxId ([string]$id)
        if (-not [string]::IsNullOrWhiteSpace($partKey) -and -not ($clean -contains $partKey)) { $clean += $partKey }
    }
    if ($clean.Count -eq 0) { throw 'No valid Part IDs supplied.' }
    if ($clean.Count -gt 900) { throw 'Use 900 or fewer unique Part IDs per batch.' }

    $conn = New-Object System.Data.SqlClient.SqlConnection $connString
    $conn.Open()
    try {
        $cmd = $conn.CreateCommand()
        $inClause = Add-InClauseParams $cmd $clean
        [void]$cmd.Parameters.Add('@WarehouseID', [System.Data.SqlDbType]::NVarChar, 30)
        $cmd.Parameters['@WarehouseID'].Value = $warehouseId
        $cmd.CommandText = @"
SELECT
    p.[ID] AS [PartId],
    ISNULL(p.[DESCRIPTION], '') AS [Description],
    ISNULL(p.[STOCK_UM], 'EA') AS [UOM],
    ISNULL(p.[STATUS], '') AS [PartStatus],
    ISNULL(ps.[PRIMARY_LOC_ID], '') AS [PrimaryLocID],
    ISNULL(ps.[PRIMARY_WHS_ID], '') AS [PrimaryWhsID],
    ISNULL(ps.[SITE_ID], '') AS [SiteID],
    CASE WHEN pl.[ID] IS NULL THEN 0 ELSE 1 END AS [PrimaryLocationExists],
    CASE
      WHEN NULLIF(LTRIM(RTRIM(ISNULL(ps.[PRIMARY_LOC_ID], ''))), '') IS NULL THEN 0
      WHEN UPPER(LTRIM(RTRIM(ISNULL(ps.[PRIMARY_LOC_ID], '')))) = 'HOLD' THEN 0
      WHEN pl.[ID] IS NULL THEN 1
      WHEN ISNULL(pl.[STATUS], '') = 'A'
       AND ISNULL(pl.[LOCKED], 'N') = 'N'
       AND ISNULL(pl.[TRANSIT], 'N') = 'N' THEN 1
      ELSE 0
    END AS [PrimaryLocationValid],
    ISNULL(pl.[QTY], 0) AS [PrimaryQty],
    ISNULL(pl.[COMMITTED_QTY], 0) AS [PrimaryCommittedQty],
    (ISNULL(pl.[QTY], 0) - ISNULL(pl.[COMMITTED_QTY], 0)) AS [PrimaryAvailableQty]
FROM [dbo].[PART] AS p
LEFT JOIN [dbo].[WAREHOUSE] AS w
  ON w.[ID] = @WarehouseID
LEFT JOIN [dbo].[PART_SITE] AS ps
  ON ps.[PART_ID] = p.[ID]
 AND ps.[SITE_ID] = w.[SITE_ID]
LEFT JOIN [dbo].[CR_PART_LOCATION] AS pl
  ON pl.[ID] = p.[ID]
 AND pl.[WAREHOUSE_ID] = @WarehouseID
 AND UPPER(LTRIM(RTRIM(ISNULL(pl.[LOCATION_ID], '')))) = UPPER(LTRIM(RTRIM(ISNULL(ps.[PRIMARY_LOC_ID], ''))))
WHERE p.[ID] IN ($inClause)
ORDER BY p.[ID];
"@
        $adapter = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
        $table = New-Object System.Data.DataTable
        [void]$adapter.Fill($table)
        $rows = Convert-TableToObjects $table

        return [ordered]@{
            ok = $true
            readSource = 'Batch SQL dbo.PART_SITE.PRIMARY_LOC_ID joined through dbo.WAREHOUSE.SITE_ID'
            primaryLocationSource = 'dbo.PART_SITE.PRIMARY_LOC_ID'
            warehouseId = $warehouseId
            requestedPartIds = @($clean)
            rows = @($rows)
            generatedAt = (Get-Date).ToString('s')
        }
    }
    finally { $conn.Close() }
}

function Search-OpenPOByVendorSql([string]$query) {
    $query = ([string]$query).Trim()
    if ($query.Length -gt 100) { $query = $query.Substring(0,100) }
    if ([string]::IsNullOrWhiteSpace($query)) { throw "Enter a Vendor ID or Vendor Name." }

    $conn = New-Object System.Data.SqlClient.SqlConnection $connString
    $conn.Open()
    try {
        $params = @{ "@VendorSearch" = ('%' + $query + '%') }
        $sqlWithVendor = @"
;WITH DeliveryAgg AS (
    SELECT
        d.[PURC_ORDER_ID],
        d.[PURC_ORDER_LINE_NO],
        COUNT(*) AS [DeliveryCount],
        SUM(CASE WHEN ISNULL(d.[ORDER_QTY],0) - ISNULL(d.[RECEIVED_QTY],0) > 0
                 THEN ISNULL(d.[ORDER_QTY],0) - ISNULL(d.[RECEIVED_QTY],0) ELSE 0 END) AS [DeliveryOpenQty],
        MIN(CASE WHEN ISNULL(d.[ORDER_QTY],0) - ISNULL(d.[RECEIVED_QTY],0) > 0
                 THEN d.[DESIRED_RECV_DATE] ELSE NULL END) AS [DeliveryDueDate]
    FROM [dbo].[PURC_LINE_DEL] AS d
    GROUP BY d.[PURC_ORDER_ID], d.[PURC_ORDER_LINE_NO]
), LineOpen AS (
    SELECT
        h.[ID] AS [POId],
        h.[VENDOR_ID] AS [VendorId],
        h.[ORDER_DATE] AS [PODate],
        h.[DESIRED_RECV_DATE] AS [HeaderDueDate],
        l.[LINE_NO] AS [LineNo],
        CASE WHEN ISNULL(da.[DeliveryCount],0) > 0 THEN ISNULL(da.[DeliveryOpenQty],0)
             WHEN ISNULL(l.[ORDER_QTY],0) - ISNULL(l.[TOTAL_RECEIVED_QTY],0) > 0
             THEN ISNULL(l.[ORDER_QTY],0) - ISNULL(l.[TOTAL_RECEIVED_QTY],0) ELSE 0 END AS [OpenQty],
        COALESCE(da.[DeliveryDueDate], l.[DESIRED_RECV_DATE], h.[DESIRED_RECV_DATE]) AS [DueDate]
    FROM [dbo].[PURCHASE_ORDER] AS h
    INNER JOIN [dbo].[PURC_ORDER_LINE] AS l ON l.[PURC_ORDER_ID] = h.[ID]
    LEFT JOIN DeliveryAgg AS da
      ON da.[PURC_ORDER_ID] = l.[PURC_ORDER_ID]
     AND da.[PURC_ORDER_LINE_NO] = l.[LINE_NO]
    WHERE h.[STATUS] = 'R'
), OpenPO AS (
    SELECT
        [POId], [VendorId], [PODate],
        SUM(CASE WHEN [OpenQty] > 0 THEN 1 ELSE 0 END) AS [OpenLineCount],
        SUM(CASE WHEN [OpenQty] > 0 THEN [OpenQty] ELSE 0 END) AS [TotalOpenQty],
        MIN(CASE WHEN [OpenQty] > 0 THEN [DueDate] ELSE NULL END) AS [EarliestDueDate]
    FROM LineOpen
    GROUP BY [POId], [VendorId], [PODate]
    HAVING SUM(CASE WHEN [OpenQty] > 0 THEN [OpenQty] ELSE 0 END) > 0
)
SELECT TOP (75)
    o.[POId],
    o.[VendorId],
    ISNULL(v.[NAME], '') AS [VendorName],
    o.[PODate],
    o.[OpenLineCount],
    o.[TotalOpenQty],
    o.[EarliestDueDate]
FROM OpenPO AS o
LEFT JOIN [dbo].[VENDOR] AS v ON v.[ID] = o.[VendorId]
WHERE o.[VendorId] LIKE @VendorSearch
   OR ISNULL(v.[NAME], '') LIKE @VendorSearch
ORDER BY ISNULL(v.[NAME], ''), o.[VendorId], o.[PODate] DESC, o.[POId] DESC;
"@
        try {
            $rows = Invoke-QxQueryParams $conn $sqlWithVendor $params
            return [ordered]@{
                ok = $true
                query = $query
                readSource = 'SQL dbo.PURCHASE_ORDER + dbo.PURC_ORDER_LINE + dbo.PURC_LINE_DEL + dbo.VENDOR'
                vendorNameAvailable = $true
                rows = @($rows)
                generatedAt = (Get-Date).ToString('s')
            }
        }
        catch {
            # Fallback keeps Vendor ID search working if this VISUAL database uses
            # a different Vendor master/table layout. No transaction code is affected.
            $sqlVendorIdOnly = @"
;WITH DeliveryAgg AS (
    SELECT d.[PURC_ORDER_ID], d.[PURC_ORDER_LINE_NO], COUNT(*) AS [DeliveryCount],
           SUM(CASE WHEN ISNULL(d.[ORDER_QTY],0)-ISNULL(d.[RECEIVED_QTY],0)>0
                    THEN ISNULL(d.[ORDER_QTY],0)-ISNULL(d.[RECEIVED_QTY],0) ELSE 0 END) AS [DeliveryOpenQty],
           MIN(CASE WHEN ISNULL(d.[ORDER_QTY],0)-ISNULL(d.[RECEIVED_QTY],0)>0
                    THEN d.[DESIRED_RECV_DATE] ELSE NULL END) AS [DeliveryDueDate]
    FROM [dbo].[PURC_LINE_DEL] d
    GROUP BY d.[PURC_ORDER_ID], d.[PURC_ORDER_LINE_NO]
), LineOpen AS (
    SELECT h.[ID] AS [POId], h.[VENDOR_ID] AS [VendorId], h.[ORDER_DATE] AS [PODate],
           CASE WHEN ISNULL(da.[DeliveryCount],0)>0 THEN ISNULL(da.[DeliveryOpenQty],0)
                WHEN ISNULL(l.[ORDER_QTY],0)-ISNULL(l.[TOTAL_RECEIVED_QTY],0)>0
                THEN ISNULL(l.[ORDER_QTY],0)-ISNULL(l.[TOTAL_RECEIVED_QTY],0) ELSE 0 END AS [OpenQty],
           COALESCE(da.[DeliveryDueDate],l.[DESIRED_RECV_DATE],h.[DESIRED_RECV_DATE]) AS [DueDate]
    FROM [dbo].[PURCHASE_ORDER] h
    INNER JOIN [dbo].[PURC_ORDER_LINE] l ON l.[PURC_ORDER_ID]=h.[ID]
    LEFT JOIN DeliveryAgg da ON da.[PURC_ORDER_ID]=l.[PURC_ORDER_ID] AND da.[PURC_ORDER_LINE_NO]=l.[LINE_NO]
    WHERE h.[STATUS]='R'
)
SELECT TOP (75) [POId], [VendorId], CAST('' AS nvarchar(100)) AS [VendorName], [PODate],
       SUM(CASE WHEN [OpenQty]>0 THEN 1 ELSE 0 END) AS [OpenLineCount],
       SUM(CASE WHEN [OpenQty]>0 THEN [OpenQty] ELSE 0 END) AS [TotalOpenQty],
       MIN(CASE WHEN [OpenQty]>0 THEN [DueDate] ELSE NULL END) AS [EarliestDueDate]
FROM LineOpen
WHERE [VendorId] LIKE @VendorSearch
GROUP BY [POId], [VendorId], [PODate]
HAVING SUM(CASE WHEN [OpenQty]>0 THEN [OpenQty] ELSE 0 END)>0
ORDER BY [VendorId], [PODate] DESC, [POId] DESC;
"@
            $rows = Invoke-QxQueryParams $conn $sqlVendorIdOnly $params
            return [ordered]@{
                ok = $true
                query = $query
                readSource = 'SQL open PO query (Vendor ID fallback; Vendor master name unavailable)'
                vendorNameAvailable = $false
                warning = 'Vendor-name lookup was not available in this VISUAL schema; search by Vendor ID.'
                rows = @($rows)
                generatedAt = (Get-Date).ToString('s')
            }
        }
    }
    finally { $conn.Close() }
}


function Read-RequestJson($ctx) {
    $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, $ctx.Request.ContentEncoding)
    try {
        $body = $reader.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($body)) { return @{} }
        return ($body | ConvertFrom-Json)
    }
    finally { $reader.Close() }
}

function Add-InClauseParams($cmd, [string[]]$ids) {
    $names = @()
    for ($i = 0; $i -lt $ids.Count; $i++) {
        $p = "@P$i"
        [void]$cmd.Parameters.Add($p, [System.Data.SqlDbType]::NVarChar, 80)
        $cmd.Parameters[$p].Value = $ids[$i]
        $names += $p
    }
    return ($names -join ',')
}

function Invoke-QxQueryIds($conn, [string]$sqlTemplate, [string[]]$ids) {
    if ($ids.Count -eq 0) { return @() }
    $cmd = $conn.CreateCommand()
    $inClause = Add-InClauseParams $cmd $ids
    $cmd.CommandText = $sqlTemplate.Replace('/*IN_PARTS*/', $inClause)
    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $table = New-Object System.Data.DataTable
    [void]$adapter.Fill($table)
    return Convert-TableToObjects $table
}

function Get-KanbanBulkSql([string[]]$partIds) {
    $clean = @()
    foreach ($id in $partIds) {
        $p = Clean-QxId ([string]$id)
        if (![string]::IsNullOrWhiteSpace($p) -and -not ($clean -contains $p)) { $clean += $p }
    }
    if ($clean.Count -eq 0) { throw "No valid Part IDs supplied." }
    if ($clean.Count -gt 900) { throw "Too many unique Part IDs. Please use 900 or fewer per scan." }

    $conn = New-Object System.Data.SqlClient.SqlConnection $connString
    $conn.Open()
    try {
        $parts = Invoke-QxQueryIds $conn @"
SELECT
    p.ID AS PartId,
    p.DESCRIPTION AS Description,
    p.STOCK_UM AS Uom,
    p.STATUS AS Status,
    p.USER_9 AS User9,
    CASE WHEN UPPER(LTRIM(RTRIM(ISNULL(p.USER_9,'')))) IN ('YES','Y','TRUE','1','KANBAN') THEN 1 ELSE 0 END AS IsKanban
FROM dbo.PART p
WHERE p.ID IN (/*IN_PARTS*/);
"@ $clean

        $stock = Invoke-QxQueryIds $conn @"
SELECT
    pl.ID AS PartId,
    pl.WAREHOUSE_ID AS WarehouseId,
    pl.LOCATION_ID AS LocationId,
    pl.QTY AS Qty,
    pl.COMMITTED_QTY AS CommittedQty,
    (ISNULL(pl.QTY,0) - ISNULL(pl.COMMITTED_QTY,0)) AS AvailableQty,
    pl.STATUS AS Status,
    pl.LOCKED AS Locked,
    pl.HOLD_REASON_ID AS HoldReasonId,
    pl.TRANSIT AS Transit,
    CASE
        WHEN pl.WAREHOUSE_ID = 'QMIL'
         AND pl.STATUS = 'A'
         AND pl.LOCKED = 'N'
         AND pl.TRANSIT = 'N'
         AND pl.LOCATION_ID <> 'HOLD'
         AND (ISNULL(pl.QTY,0) - ISNULL(pl.COMMITTED_QTY,0)) > 0
        THEN 1 ELSE 0
    END AS UsableForAdjust
FROM dbo.CR_PART_LOCATION pl
WHERE pl.WAREHOUSE_ID = 'QMIL'
  AND pl.ID IN (/*IN_PARTS*/)
ORDER BY pl.ID, UsableForAdjust DESC, pl.LOCATION_ID;
"@ $clean

        $pos = Invoke-QxQueryIds $conn @"
SELECT TOP (3000)
    q.[PART_ID] AS [PartId],
    q.[PURC_ORDER_ID] AS [POId],
    q.[LINE_NO] AS [LineNo],
    q.[VENDOR_ID] AS [VendorId],
    ISNULL(q.[VENDOR_PART_ID], '') AS [VendorPartId],
    q.[ORDER_QTY] AS [OrderQty],
    q.[TOTAL_RECEIVED_QTY] AS [ReceivedQty],
    (q.[ORDER_QTY] - q.[TOTAL_RECEIVED_QTY]) AS [OpenQty],
    q.[DESIRED_RECV_DATE] AS [DueDate],
    ISNULL((
        SELECT TOP (1) COALESCE(NULLIF(d.[USER_1], ''), NULLIF(l.[USER_1], ''), '')
        FROM [dbo].[PURC_ORDER_LINE] AS l
        LEFT JOIN [dbo].[PURC_LINE_DEL] AS d
            ON d.[PURC_ORDER_ID] = l.[PURC_ORDER_ID]
           AND d.[PURC_ORDER_LINE_NO] = l.[LINE_NO]
        WHERE l.[PURC_ORDER_ID] = q.[PURC_ORDER_ID]
          AND l.[LINE_NO] = q.[LINE_NO]
    ), '') AS [UserDefined1]
FROM [dbo].[QUICKMILL_PURCHASEORDERS] AS q
WHERE q.[PART_ID] IN (/*IN_PARTS*/)
  AND (q.[ORDER_QTY] - q.[TOTAL_RECEIVED_QTY]) > 0
ORDER BY q.[PART_ID], q.[DESIRED_RECV_DATE], q.[PURC_ORDER_ID], q.[LINE_NO];
"@ $clean

        $demand = Invoke-QxQueryIds $conn @"
SELECT
    r.ID AS PartId,
    COUNT(*) AS DemandRows,
    SUM(ISNULL(r.CALC_QTY,0) - ISNULL(r.ISSUED_QTY,0)) AS ActiveDemandQty
FROM dbo.CR_PART_REQ r
JOIN dbo.WORK_ORDER w
    ON w.TYPE = r.WORKORDER_TYPE
    AND w.BASE_ID = r.WORKORDER_BASE_ID
    AND w.LOT_ID = r.WORKORDER_LOT_ID
    AND w.SPLIT_ID = r.WORKORDER_SPLIT_ID
    AND w.SUB_ID = r.WORKORDER_SUB_ID
WHERE r.ID IN (/*IN_PARTS*/)
  AND w.STATUS IN ('F','R')
  AND r.STATUS IN ('F','R')
  AND (ISNULL(r.CALC_QTY,0) - ISNULL(r.ISSUED_QTY,0)) > 0
GROUP BY r.ID;
"@ $clean

        $partMap = @{}
        foreach ($p in $parts) { $partMap[[string]$p.PartId] = $p }

        $stockMap = @{}
        foreach ($s in $stock) {
            $partKey = [string]$s.PartId
            if (-not $stockMap.ContainsKey($partKey)) { $stockMap[$partKey] = @() }
            $stockMap[$partKey] += $s
        }

        $poMap = @{}
        foreach ($po in $pos) {
            $partKey = [string]$po.PartId
            if (-not $poMap.ContainsKey($partKey)) { $poMap[$partKey] = @() }
            $poMap[$partKey] += $po
        }

        $demandMap = @{}
        foreach ($d in $demand) { $demandMap[[string]$d.PartId] = $d }

        $rows = @()
        foreach ($partKey in $clean) {
            $p = $null
            if ($partMap.ContainsKey($partKey)) { $p = $partMap[$partKey] }
            $isValid = ($null -ne $p)
            $locs = @()
            if ($stockMap.ContainsKey($partKey)) { $locs = @($stockMap[$partKey]) }
            $incoming = @()
            if ($poMap.ContainsKey($partKey)) { $incoming = @($poMap[$partKey]) }
            $dem = $null
            if ($demandMap.ContainsKey($partKey)) { $dem = $demandMap[$partKey] }

            $available = [decimal]0
            $holdQty = [decimal]0
            $usableLocs = @()
            foreach ($l in $locs) {
                $avail = [decimal]($l.AvailableQty)
                if ([int]($l.UsableForAdjust) -eq 1) {
                    $available += $avail
                    $usableLocs += $l
                } elseif ([string]($l.LocationId) -eq 'HOLD' -or [string]($l.Status) -ne 'A') {
                    if ([decimal]($l.Qty) -gt 0) { $holdQty += [decimal]($l.Qty) }
                }
            }
            $openPo = [decimal]0
            $udf1 = ''
            foreach ($po in $incoming) {
                $openPo += [decimal]($po.OpenQty)
                if ([string]::IsNullOrWhiteSpace($udf1) -and -not [string]::IsNullOrWhiteSpace([string]$po.UserDefined1)) { $udf1 = [string]$po.UserDefined1 }
            }
            $action = 'INVALID'
            if ($isValid) {
                if ($available -gt 0) { $action = 'IN_STOCK' }
                elseif ($openPo -gt 0) { $action = 'ON_PO' }
                else { $action = 'NEEDS_REORDER' }
            }
            $rows += [pscustomobject][ordered]@{
                partId = $partKey
                isValid = $isValid
                description = if ($isValid) { [string]$p.Description } else { '' }
                uom = if ($isValid) { [string]$p.Uom } else { '' }
                status = if ($isValid) { [string]$p.Status } else { '' }
                kanban = if ($isValid) { ([int]$p.IsKanban -eq 1) } else { $false }
                user9 = if ($isValid) { [string]$p.User9 } else { '' }
                availableQty = $available
                holdQty = $holdQty
                openPOQty = $openPo
                userDefined1 = $udf1
                demandRows = if ($dem) { [int]$dem.DemandRows } else { 0 }
                activeDemandQty = if ($dem) { [decimal]$dem.ActiveDemandQty } else { [decimal]0 }
                suggestedAction = $action
                # KANBAN UI should only show/select stock locations with usable available stock.
                locations = @($usableLocs | ForEach-Object { [pscustomobject][ordered]@{
                    locationId = [string]$_.LocationId
                    qty = [decimal]$_.Qty
                    committedQty = [decimal]$_.CommittedQty
                    availableQty = [decimal]$_.AvailableQty
                    status = [string]$_.Status
                    locked = [string]$_.Locked
                    transit = [string]$_.Transit
                    holdReasonId = [string]$_.HoldReasonId
                    usableForAdjust = [int]$_.UsableForAdjust
                }})
                incomingPOs = @($incoming | ForEach-Object { [pscustomobject][ordered]@{
                    poId = [string]$_.POId
                    lineNo = [string]$_.LineNo
                    vendorId = [string]$_.VendorId
                    vendorPartId = [string]$_.VendorPartId
                    orderQty = [decimal]$_.OrderQty
                    receivedQty = [decimal]$_.ReceivedQty
                    openQty = [decimal]$_.OpenQty
                    dueDate = $_.DueDate
                    userDefined1 = [string]$_.UserDefined1
                }})
            }
        }

        return [ordered]@{
            ok = $true
            bridgeVersion = "QX Web 1.10 Beta v0.6 Inventory Adjust SQL + Location Fix"
            readSource = "SQL bulk: dbo.PART + dbo.CR_PART_LOCATION + dbo.QUICKMILL_PURCHASEORDERS + UDF1 lookup"
            generatedAt = (Get-Date).ToString("s")
            summary = [ordered]@{
                inputCount = $partIds.Count
                uniqueCount = $clean.Count
                totalRows = @($rows).Count
                inStock = @($rows | Where-Object { $_.suggestedAction -eq 'IN_STOCK' }).Count
                onPO = @($rows | Where-Object { $_.suggestedAction -eq 'ON_PO' }).Count
                needsReorder = @($rows | Where-Object { $_.suggestedAction -eq 'NEEDS_REORDER' }).Count
                invalid = @($rows | Where-Object { $_.suggestedAction -eq 'INVALID' }).Count
            }
            rows = @($rows)
        }
    }
    finally { $conn.Close() }
}

function Send-Json($ctx, $statusCode, $obj) {
    $json = $obj | ConvertTo-Json -Depth 20
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $ctx.Response.StatusCode = $statusCode
    $ctx.Response.ContentType = "application/json; charset=utf-8"
    $ctx.Response.Headers["Cache-Control"] = "no-store"
    $ctx.Response.Headers["X-Content-Type-Options"] = "nosniff"
    $ctx.Response.Headers["X-Frame-Options"] = "DENY"
    $ctx.Response.Headers["Referrer-Policy"] = "no-referrer"
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.OutputStream.Close()
}

# ---- QX Web: static file serving ----
function Get-ContentType($path) {
    switch ([System.IO.Path]::GetExtension($path).ToLowerInvariant()) {
        ".html" { "text/html; charset=utf-8" }
        ".js"   { "application/javascript; charset=utf-8" }
        ".css"  { "text/css; charset=utf-8" }
        ".json" { "application/json; charset=utf-8" }
        ".png"  { "image/png" }
        ".jpg"  { "image/jpeg" }
        ".svg"  { "image/svg+xml" }
        ".ico"  { "image/x-icon" }
        default { "application/octet-stream" }
    }
}
function Send-File($ctx, $fullPath) {
    $bytes = [System.IO.File]::ReadAllBytes($fullPath)
    $ctx.Response.StatusCode = 200
    $ctx.Response.ContentType = Get-ContentType $fullPath
    $ctx.Response.Headers["X-Content-Type-Options"] = "nosniff"
    $ctx.Response.Headers["X-Frame-Options"] = "DENY"
    $ctx.Response.Headers["Referrer-Policy"] = "no-referrer"
    if ([System.IO.Path]::GetFileName($fullPath).ToLowerInvariant() -eq "app.html") {
        $ctx.Response.Headers["Cache-Control"] = "no-store, max-age=0"
    } else {
        $ctx.Response.Headers["Cache-Control"] = "no-cache"
    }
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.OutputStream.Close()
}
function Serve-Static($ctx, $webRoot, $rawPath) {
    $rel = $rawPath.TrimStart("/")
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = "app.html" }
    # Serve only the production web assets. Do not expose scripts, configs,
    # manifests, logs, or internal documentation over the LAN.
    $allowed = @("app.html","app.js","app.css","premium.css","adjust-native.js","qx_logo.png","qx_logo_cyan.png","favicon.ico")
    if (-not ($allowed -contains $rel.ToLowerInvariant())) { Send-Json $ctx 404 @{ ok = $false; error = "file not found" }; return }
    # block path traversal
    if ($rel.Contains("..")) { Send-Json $ctx 400 @{ ok = $false; error = "bad path" }; return }
    $full = Join-Path $webRoot $rel
    if (Test-Path $full -PathType Leaf) { Send-File $ctx $full; return }
    # default document
    if ($rawPath -eq "/" ) { $idx = Join-Path $webRoot "app.html"; if (Test-Path $idx) { Send-File $ctx $idx; return } }
    Send-Json $ctx 404 @{ ok = $false; error = "file not found"; path = $rawPath }
}

# ---- QX Web: RF Plus reverse proxy (server-to-server, no browser CORS) ----
function Proxy-RF($ctx, $targetBase, $stripPrefix) {
    $req = $ctx.Request
    $tail = $req.Url.PathAndQuery
    if ($stripPrefix -and $tail.ToLowerInvariant().StartsWith($stripPrefix)) {
        $tail = $tail.Substring($stripPrefix.Length)
    }
    if (-not $tail.StartsWith("/")) { $tail = "/" + $tail }
    $targetUrl = $targetBase + $tail

    $proxyReq = [System.Net.HttpWebRequest]::Create($targetUrl)
    $proxyReq.Method = $req.HttpMethod
    $proxyReq.AllowAutoRedirect = $false
    $proxyReq.Timeout = 60000
    # Forward auth + content type so RF Plus token-based calls work.
    $auth = $req.Headers["Authorization"]; if ($auth) { $proxyReq.Headers.Add("Authorization", $auth) }
    $ctype = $req.ContentType; if ($ctype) { $proxyReq.ContentType = $ctype } else { $proxyReq.ContentType = "application/json" }
    $proxyReq.Accept = "application/json, text/plain, */*"

    if ($req.HttpMethod -eq "POST" -or $req.HttpMethod -eq "PUT") {
        $reader = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
        $body = $reader.ReadToEnd(); $reader.Close()
        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $proxyReq.ContentLength = $bodyBytes.Length
        $stream = $proxyReq.GetRequestStream(); $stream.Write($bodyBytes, 0, $bodyBytes.Length); $stream.Close()
    }

    try {
        $resp = $proxyReq.GetResponse()
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if (-not $resp) {
            Send-Json $ctx 502 @{ ok = $false; error = "RF Plus unreachable: " + $_.Exception.Message }
            return
        }
    }
    $respStream = $resp.GetResponseStream()
    $ms = New-Object System.IO.MemoryStream
    $respStream.CopyTo($ms)
    $bytes = $ms.ToArray(); $ms.Close(); $respStream.Close()

    $ctx.Response.StatusCode = [int]$resp.StatusCode
    try { $ctx.Response.ContentType = $resp.ContentType } catch {}
    $ctx.Response.Headers["Cache-Control"] = "no-store"
    $ctx.Response.Headers["X-Content-Type-Options"] = "nosniff"
    $ctx.Response.Headers["X-Frame-Options"] = "DENY"
    $ctx.Response.Headers["Referrer-Policy"] = "no-referrer"
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.OutputStream.Close()
    $resp.Close()
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($Prefix)

try {
    $listener.Start()
} catch {
    Write-Host "Could not start listener at $Prefix" -ForegroundColor Red
    Write-Host "Try running PowerShell as Administrator, or run:" -ForegroundColor Yellow
    Write-Host "netsh http add urlacl url=$Prefix user=$env:USERDOMAIN\$env:USERNAME" -ForegroundColor Yellow
    throw
}

Write-Log "QX Web Server (QX Web 1.10 Beta v0.6 Inventory Adjust SQL + Location Fix) started"
Write-Log "Web root:  $WebRoot"
Write-Log "Listening: $Prefix"
Write-Log "Open QX:   http://<this-pc-ip>:8080/   (others use this link)"
Write-Log "RF proxy:  ${Prefix}rf  ->  $RfBase"
Write-Log "Health:    ${Prefix}api/health"
Write-Log "Press Ctrl+C to stop."

$script:listener = $listener
$script:bridgeStopping = $false
try {
    [Console]::TreatControlCAsInput = $false
    [Console]::add_CancelKeyPress({
        param($sender, $eventArgs)
        $eventArgs.Cancel = $true
        $script:bridgeStopping = $true
        Write-Host ""
        Write-Log "Stopping QX SQL Bridge..."
        try { if ($script:listener -and $script:listener.IsListening) { $script:listener.Stop() } } catch {}
    })
} catch {}

while ($listener.IsListening -and -not $script:bridgeStopping) {
    $async = $null
    try {
        $async = $listener.BeginGetContext($null, $null)
        while (-not $async.AsyncWaitHandle.WaitOne(250)) {
            if ($script:bridgeStopping -or -not $listener.IsListening) { break }
        }
        if ($script:bridgeStopping -or -not $listener.IsListening) { break }
        $ctx = $listener.EndGetContext($async)
    } catch {
        if ($script:bridgeStopping -or -not $listener.IsListening) { break }
        Write-Log ("Listener error: " + $_.Exception.Message)
        continue
    }
    try {
        $path = $ctx.Request.Url.AbsolutePath.ToLowerInvariant()

        if ($ctx.Request.HttpMethod -eq "OPTIONS") {
            Send-Json $ctx 200 @{ ok = $true }
            continue
        }

        if ($path -eq "/api/health") {
            Send-Json $ctx 200 ([ordered]@{
                ok = $true
                service = "QX SQL Bridge"
                version = "QX Web 1.10 Beta v0.6 Inventory Adjust SQL + Location Fix"
                server = $Server
                database = $Database
                modules = @("Part Lookup", "Returnable", "WO", "PO Receiving", "KANBAN", "Inventory Adjust")
                endpoints = @("/api/partlookup", "/api/returnablecheck", "/api/wo", "/api/worequirements", "/api/po", "/api/po/vendor-search", "/api/inventory-adjust/part", "/api/inventory-adjust/primary-locations", "/api/kanban/bulk")
                time = (Get-Date).ToString("s")
            })
            continue
        }

        if ($path -eq "/api/kanbancheck") {
            $partId = ($ctx.Request.QueryString["partId"] -replace "[^A-Za-z0-9_\-\.\/ ]", "").Trim().ToUpperInvariant()
            $conn = New-Object System.Data.SqlClient.SqlConnection $connString
            $conn.Open()
            try {
                $rows = Invoke-QxQuery $conn @"
SELECT TOP 1
    ID,
    DESCRIPTION,
    USER_9,
    LTRIM(RTRIM(ISNULL(USER_9, ''))) AS KANBAN_VALUE,
    CASE WHEN UPPER(LTRIM(RTRIM(ISNULL(USER_9, '')))) IN ('YES','Y','TRUE','1','KANBAN') THEN 1 ELSE 0 END AS IS_KANBAN
FROM dbo.PART
WHERE ID = @PartID;
"@ $partId
                Send-Json $ctx 200 ([ordered]@{
                    ok = $true
                    bridgeVersion = "QX Web 1.10 Beta v0.6 Inventory Adjust SQL + Location Fix"
                    source = "QM.dbo.PART.USER_9"
                    partId = $partId
                    rows = @($rows)
                })
            }
            finally { $conn.Close() }
            continue
        }


        if ($path -eq "/api/returnablecheck") {
            $partId = $ctx.Request.QueryString["partId"]
            $result = Get-PartLookup $partId
            Send-Json $ctx 200 ([ordered]@{
                ok = $true
                bridgeVersion = "QX Web 1.10 Beta v0.6 Inventory Adjust SQL + Location Fix"
                partId = $result.partId
                issuedReturnableRows = $result.summary.issuedReturnableRows
                totalIssuedQty = $result.summary.totalIssuedQty
                issued = $result.issued
            })
            continue
        }

        if ($path -eq "/api/wo") {
            $woId = $ctx.Request.QueryString["woId"]
            $result = Get-WOListSql $woId
            Send-Json $ctx 200 $result
            continue
        }

        if ($path -eq "/api/worequirements" -or $path -eq "/api/wo-requirements") {
            $woId = $ctx.Request.QueryString["woId"]
            $lotId = $ctx.Request.QueryString["lotId"]
            $splitId = $ctx.Request.QueryString["splitId"]
            $subId = $ctx.Request.QueryString["subId"]
            $result = Get-WORequirementsSql $woId $lotId $splitId $subId
            Send-Json $ctx 200 $result
            continue
        }


        if ($path -eq "/api/podebug") {
            $poId = $ctx.Request.QueryString["poId"]
            $poIdClean = Clean-QxId $poId
            $conn = New-Object System.Data.SqlClient.SqlConnection $connString
            $conn.Open()
            try {
                $headerCount = Invoke-QxQueryParams $conn "SELECT COUNT(*) AS Cnt FROM dbo.PURCHASE_ORDER WHERE ID = @POID;" @{ "@POID" = $poIdClean }
                $lineCount = Invoke-QxQueryParams $conn "SELECT COUNT(*) AS Cnt FROM dbo.PURC_ORDER_LINE WHERE PURC_ORDER_ID = @POID;" @{ "@POID" = $poIdClean }
                $deliveryCount = Invoke-QxQueryParams $conn "SELECT COUNT(*) AS Cnt FROM dbo.PURC_LINE_DEL WHERE PURC_ORDER_ID = @POID;" @{ "@POID" = $poIdClean }
                $sampleLines = Invoke-QxQueryParams $conn @"
SELECT TOP 20
    PURC_ORDER_ID,
    LINE_NO,
    PART_ID,
    VENDOR_PART_ID,
    SERVICE_ID,
    ORDER_QTY,
    TOTAL_RECEIVED_QTY,
    PURCHASE_UM,
    LINE_STATUS,
    DESIRED_RECV_DATE,
    PROMISE_DATE,
    USER_1,
    WAREHOUSE_ID
FROM dbo.PURC_ORDER_LINE
WHERE PURC_ORDER_ID = @POID
ORDER BY LINE_NO;
"@ @{ "@POID" = $poIdClean }
                Send-Json $ctx 200 ([ordered]@{
                    ok = $true
                    bridgeVersion = "QX Web 1.10 Beta v0.6 Inventory Adjust SQL + Location Fix"
                    POId = $poIdClean
                    tableCounts = [ordered]@{
                        purchaseOrder = @($headerCount)[0].Cnt
                        purcOrderLine = @($lineCount)[0].Cnt
                        purcLineDel = @($deliveryCount)[0].Cnt
                    }
                    sampleLines = @($sampleLines)
                    generatedAt = (Get-Date).ToString("s")
                })
            }
            finally { $conn.Close() }
            continue
        }


        if ($path -eq "/api/kanban/bulk") {
            if ($ctx.Request.HttpMethod -ne "POST") { Send-Json $ctx 405 @{ ok = $false; error = "POST required" }; continue }
            $body = Read-RequestJson $ctx
            $ids = @()
            if ($null -ne $body.partIds) { foreach ($x in @($body.partIds)) { $ids += [string]$x } }
            $result = Get-KanbanBulkSql $ids
            Send-Json $ctx 200 $result
            continue
        }

        if ($path -eq "/api/po" -or $path -eq "/api/polines") {
            $poId = $ctx.Request.QueryString["poId"]
            $result = Get-POReceivingSql $poId
            Send-Json $ctx 200 $result
            continue
        }

        if ($path -eq "/api/po/vendor-search") {
            $query = $ctx.Request.QueryString["q"]
            $result = Search-OpenPOByVendorSql $query
            Send-Json $ctx 200 $result
            continue
        }

        if ($path -eq "/api/inventory-adjust/primary-locations") {
            if ($ctx.Request.HttpMethod -ne "POST") { Send-Json $ctx 405 @{ ok = $false; error = "POST required" }; continue }
            $body = Read-RequestJson $ctx
            $partIds = @($body.partIds)
            $warehouseId = [string]$body.warehouseId
            $result = Get-InventoryAdjustPrimaryLocationsSql $partIds $warehouseId
            Send-Json $ctx 200 $result
            continue
        }

        if ($path -eq "/api/inventory-adjust/part") {
            $partId = $ctx.Request.QueryString["partId"]
            $warehouseId = $ctx.Request.QueryString["warehouseId"]
            $result = Get-InventoryAdjustPartSql $partId $warehouseId
            Send-Json $ctx 200 $result
            continue
        }

        if ($path -eq "/api/partlookup" -or $path -eq "/api/part-lookup") {
            $partId = $ctx.Request.QueryString["partId"]
            $result = Get-PartLookup $partId
            Send-Json $ctx 200 $result
            continue
        }

        # ---- RF Plus reverse proxy: browser calls /rf/... and /rf9000/... ----
        if ($path -eq "/rf" -or $path.StartsWith("/rf/")) {
            Proxy-RF $ctx $RfBase "/rf"
            continue
        }
        if ($path -eq "/rf9000" -or $path.StartsWith("/rf9000/")) {
            Proxy-RF $ctx $Rf9000Base "/rf9000"
            continue
        }

        # ---- Anything else: serve the QuickX website files ----
        if (-not $path.StartsWith("/api/")) {
            Serve-Static $ctx $WebRoot $ctx.Request.Url.AbsolutePath
            continue
        }

        Send-Json $ctx 404 @{ ok = $false; error = "Not found"; path = $path }
    }
    catch {
        try {
            Send-Json $ctx 500 @{ ok = $false; error = $_.Exception.Message }
        } catch {}
    }
}


try { if ($listener -and $listener.IsListening) { $listener.Stop() } } catch {}
try { if ($listener) { $listener.Close() } } catch {}
Write-Log "QX SQL Bridge stopped."
