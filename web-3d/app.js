import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ================================================================
// NAVIGATION & PAGE MANAGEMENT
// ================================================================
let currentPage = 'live';

// =====================================================================
//  ACTIVITY LOG — fed by onMessageArrived, shown on Overview page
// =====================================================================
const ACTIVITY_MAX = 50;
const activityLog  = []; // { time, text, severity }

function _logEvent(text, severity = 'info') {
    const now = new Date();
    const ts  = now.getHours().toString().padStart(2,'0') + ':'
              + now.getMinutes().toString().padStart(2,'0') + ':'
              + now.getSeconds().toString().padStart(2,'0');
    activityLog.unshift({ time: ts, text, severity });
    if (activityLog.length > ACTIVITY_MAX) activityLog.pop();
    // live-refresh overview if open
    if (currentPage === 'overview') _refreshOverviewDynamic();
}

// =====================================================================
//  LIVE ASSET STATUS — helpers to read DOM chips from live twin
// =====================================================================
function _getAssetStatus(id) {
    // id = 'a1' | 'a2' | 'a3'
    const chip = document.getElementById(id + '-chip');
    if (!chip) return 'unknown';
    const txt = chip.textContent.trim().toLowerCase();
    if (txt.includes('critical') || txt.includes('anomaly') || txt.includes('failure')) return 'critical';
    if (txt.includes('warning') || txt.includes('stale') || txt.includes('degraded')) return 'warning';
    if (txt.includes('healthy') || txt.includes('normal') || txt.includes('optimal')) return 'healthy';
    return 'initializing';
}

function _countAlerts() {
    return ['a1','a2','a3'].filter(id => _getAssetStatus(id) === 'critical').length;
}

function _uptimeStr() {
    const sec = Math.floor((Date.now() - startTime) / 1000);
    const h   = Math.floor(sec / 3600);
    const m   = Math.floor((sec % 3600) / 60);
    const s   = sec % 60;
    return h > 0
        ? `${h}h ${m.toString().padStart(2,'0')}m`
        : `${m.toString().padStart(2,'0')}m ${s.toString().padStart(2,'0')}s`;
}

// Called every second to refresh dynamic elements on overview
function _refreshOverviewDynamic() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    // KPI strip
    const alerts = _countAlerts();
    set('ov-uptime',  _uptimeStr());
    set('ov-msgs',    msgCount.toLocaleString());
    set('ov-alerts',  alerts);

    // Alert color
    const alertEl = document.getElementById('ov-alerts');
    if (alertEl) alertEl.style.color = alerts > 0 ? 'var(--accent-red)' : 'var(--accent-green)';

    // Asset status badges
    ['a1','a2','a3'].forEach(id => {
        const badge = document.getElementById('ov-badge-' + id);
        if (!badge) return;
        const status = _getAssetStatus(id);
        badge.className = 'status-badge ' + (status === 'initializing' ? 'warning' : status);
        badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    });

    // Last-seen
    ['A1','A2','A3'].forEach(id => {
        const el = document.getElementById('ov-lastseen-' + id.toLowerCase());
        if (!el) return;
        const ls = assetTelemetry[id] && assetTelemetry[id].lastSeen;
        if (!ls) { el.textContent = 'No data yet'; return; }
        const ago = Math.floor((Date.now() - ls) / 1000);
        el.textContent = ago < 5 ? 'Just now' : ago + 's ago';
    });

    // Activity log
    const logEl = document.getElementById('ov-activity-log');
    if (logEl && activityLog.length > 0) {
        logEl.innerHTML = activityLog.slice(0, 12).map(e => `
            <div class="activity-item">
                <span class="activity-time">${e.time}</span>
                <span class="activity-text" style="color:${
                    e.severity === 'critical' ? 'var(--accent-red)'
                  : e.severity === 'warning'  ? 'var(--accent-amber)'
                  : 'var(--text-primary)'}">${e.text}</span>
            </div>`).join('');
    } else if (logEl && activityLog.length === 0) {
        logEl.innerHTML = '<div class="activity-item"><span class="activity-text" style="color:var(--text-muted)">Waiting for MQTT data...</span></div>';
    }
}

// =====================================================================
//  VISUALISATION — Ring buffers (50 pts) fed by onMessageArrived
// =====================================================================
const VIZ_MAX = 50; // max data-points kept per series

const vizData = {
    A1: {
        failureProb: [],   // 0-100 %
        timestamps:  [],
    },
    A2: {
        cooler:     [],    // 0-100 %
        valve:      [],    // 0-100 %
        timestamps: [],
    },
    A3: {
        anomalyScore: [],  // 0-1
        timestamps:   [],
    },
    // message-rate counter (updated every second)
    msgRate: [],
    msgRateTs: [],
};

let _vizMsgCountLast = 0;   // used for msg/s calculation

function _vizPush(arr, val) {
    arr.push(val);
    if (arr.length > VIZ_MAX) arr.shift();
}

function _vizTimestamp() {
    const d = new Date();
    return d.getHours().toString().padStart(2,'0') + ':'
         + d.getMinutes().toString().padStart(2,'0') + ':'
         + d.getSeconds().toString().padStart(2,'0');
}

// Tick: update msg/s ring buffer every second
setInterval(() => {
    const rate = msgCount - _vizMsgCountLast;
    _vizMsgCountLast = msgCount;
    _vizPush(vizData.msgRate,   rate);
    _vizPush(vizData.msgRateTs, _vizTimestamp());
    // if vis page is open, refresh live charts
    if (currentPage === 'visualisation') _vizRefreshCharts();
}, 1000);

function initNavigation() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const sidebarItems = document.querySelectorAll('.sidebar-item');

    // Toggle sidebar with hamburger button
    hamburgerBtn.addEventListener('click', () => {
        sidebar.classList.toggle('active');
        sidebarOverlay.classList.toggle('active');
    });

    // Close sidebar when clicking overlay
    sidebarOverlay.addEventListener('click', () => {
        sidebar.classList.remove('active');
        sidebarOverlay.classList.remove('active');
    });

    // Handle sidebar navigation
    sidebarItems.forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;
            navigateToPage(page);
            
            // Close sidebar
            sidebar.classList.remove('active');
            sidebarOverlay.classList.remove('active');
        });
    });
}

function navigateToPage(page) {
    currentPage = page;
    
    // Update active sidebar item
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === page) {
            item.classList.add('active');
        }
    });

    // Show/hide page contents
    document.querySelectorAll('.page-content').forEach(container => {
        container.classList.remove('active');
        if (container.dataset.page === page) {
            container.classList.add('active');
        }
    });

    // Show/hide UI overlay only on live page
    const uiOverlay = document.getElementById('ui-overlay');
    if (page === 'live') {
        uiOverlay.style.opacity = '1';
        uiOverlay.style.pointerEvents = 'auto';
    } else {
        uiOverlay.style.opacity = '0';
        uiOverlay.style.pointerEvents = 'none';
    }

    // Render page content
    if (page === 'overview') {
        renderOverviewPage();
    } else if (page === 'analytics') {
        renderAnalyticsPage();
    } else if (page === 'visualisation') {
        renderVisualisationPage();
    } else if (page === 'docs') {
        renderDocumentationPage();
    }
}

// Helper function to safely get text content
function getTextContent(id) {
    const el = document.getElementById(id);
    return el ? el.textContent : '—';
}

// =====================================================================
//  ASSET PANEL — 3D scene shift helpers
//  Base Y positions (set after buildA1/A2/A3 + ground creation)
//  We shift ground, grid & all asset groups by PANEL_LIFT when a
//  detail panel opens, then restore them when it closes.
// =====================================================================
const PANEL_LIFT = 60;         // units to raise everything when panel opens
let   panelLiftActive  = false; // guard against double-apply
let   sceneLiftedCount = 0;     // tracks if scene is physically lifted

function _applyPanelLift(delta) {
    // ground & grid (set globally after scene init — resolved at runtime)
    if (window._ground) window._ground.position.y += delta;
    if (window._grid)   window._grid.position.y   += delta;
    // all asset groups
    ['A1', 'A2', 'A3'].forEach(id => {
        const g = assets[id] && assets[id].group;
        if (g) g.position.y += delta;
    });
}

function raisePanelScene() {
    if (panelLiftActive) return;
    panelLiftActive = true;
    sceneLiftedCount++;
    _applyPanelLift(+PANEL_LIFT);
}

function restorePanelScene() {
    // Scene stays raised visually — just reset the open/close guard
    panelLiftActive = false;
}

// Asset detail panel functions
function openAssetDetail(assetId) {
    const overlay = document.getElementById('asset-detail-overlay');
    const panel = document.getElementById('asset-detail-panel');
    const content = document.getElementById('detail-content');
    
    // Populate content
    let title = '';
    let description = '';
    let details = [];
    let performance = [];
    let accentColor = '';
    
    switch(assetId) {
        case 'A1':
            title = 'A1 — CNC Milling Machine';
            description = 'Precision CNC machining center for metal parts.';
            accentColor = 'var(--a1-color)';
            details = [
                { label: 'Location', value: 'Workshop Zone 1' },
                { label: 'Type', value: 'Vertical Machining Center' },
                { label: 'Model', value: 'VMC-850' },
                { label: 'Serial', value: 'VMC-2023-0042' },
                { label: 'Install Date', value: '2023-06-15' }
            ];
            performance = [
                { label: 'Machine Status', value: getTextContent('a1-status') },
                { label: 'Failure Probability', value: getTextContent('a1-prob') },
                { label: 'Last Update', value: getTextContent('a1-last') },
                { label: 'Status', value: getTextContent('a1-chip') }
            ];
            break;
        case 'A2':
            title = 'A2 — Hydraulic System';
            description = 'High-pressure hydraulic power unit for industrial machines.';
            accentColor = 'var(--a2-color)';
            details = [
                { label: 'Location', value: 'Workshop Zone 1' },
                { label: 'Type', value: 'Hydraulic Power Unit' },
                { label: 'Model', value: 'HPU-200' },
                { label: 'Serial', value: 'HPU-2023-0018' },
                { label: 'Install Date', value: '2023-03-22' }
            ];
            performance = [
                { label: 'Cooler Condition', value: getTextContent('a2-cooler') },
                { label: 'Valve Health', value: getTextContent('a2-valve') },
                { label: 'Last Update', value: getTextContent('a2-last') },
                { label: 'Status', value: getTextContent('a2-chip') }
            ];
            break;
        case 'A3':
            title = 'A3 — APU Compressor';
            description = 'Air compressor unit for pneumatic systems and tools.';
            accentColor = 'var(--a3-color)';
            details = [
                { label: 'Location', value: 'Workshop Zone 2' },
                { label: 'Type', value: 'Rotary Screw Compressor' },
                { label: 'Model', value: 'RSC-150' },
                { label: 'Serial', value: 'RSC-2023-0076' },
                { label: 'Install Date', value: '2023-09-08' }
            ];
            performance = [
                { label: 'Anomaly Status', value: getTextContent('a3-status') },
                { label: 'Anomaly Score', value: getTextContent('a3-score') },
                { label: 'Last Update', value: getTextContent('a3-last') },
                { label: 'Status', value: getTextContent('a3-chip') }
            ];
            break;
    }
    
    // Build HTML with matching asset card style
    let html = `
        <style>
            .detail-header {
                display: flex;
                gap: 12px;
                margin-bottom: 16px;
            }
            .detail-icon {
                width: 40px;
                height: 40px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: var(--radius-sm);
                border: 1px solid ${accentColor};
                background: rgba(0, 0, 0, 0.2);
                color: ${accentColor};
            }
        </style>
        
        <div class="detail-header">
            <div class="detail-icon">
                ${assetId === 'A1' ? '⚙️' : assetId === 'A2' ? '🔧' : '🌀'}
            </div>
            <div>
                <h2 style="color: var(--text-primary); margin: 0; font-size: 1.1rem;">${title}</h2>
                <span style="color: var(--text-muted); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.08em;">
                    ${assetId === 'A1' ? 'Supervised Classification' : assetId === 'A2' ? 'Multi-target Classification' : 'Unsupervised Anomaly Detection'}
                </span>
            </div>
        </div>
        
        <p style="color: var(--text-secondary); margin-bottom: 24px; font-size: 0.9rem;">${description}</p>
        
        <div class="detail-section">
            <h3>Asset Details</h3>
            ${details.map(d => `
                <div class="detail-item">
                    <span>${d.label}</span>
                    <span class="value">${d.value}</span>
                </div>
            `).join('')}
        </div>
        
        <div class="detail-section">
            <h3>Performance</h3>
            ${performance.map(p => `
                <div class="detail-item">
                    <span>${p.label}</span>
                    <span class="value">${p.value}</span>
                </div>
            `).join('')}
        </div>
    `;
    
    content.innerHTML = html;
    
    // Raise 3D scene so the machine is well visible in the background
    raisePanelScene();

    // Show panel
    overlay.style.display = 'block';
    setTimeout(() => {
        overlay.classList.add('active');
        panel.classList.add('active');
    }, 10);
}

function closeAssetDetail() {
    const overlay = document.getElementById('asset-detail-overlay');
    const panel = document.getElementById('asset-detail-panel');
    
    overlay.classList.remove('active');
    panel.classList.remove('active');

    // Restore 3D scene to original positions
    restorePanelScene();
    
    setTimeout(() => {
        overlay.style.display = 'none';
    }, 300);
}

// =====================================================================
//  VISUALISATION PAGE
// =====================================================================

// Chart.js instances — kept so we can update data without re-rendering
const _vizCharts = {};

// Chart.js shared defaults (dark theme)
function _vizChartDefaults(color, label, unit = '') {
    return {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label,
                data: [],
                borderColor: color,
                backgroundColor: color + '22',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                fill: true,
                tension: 0.4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10,14,26,0.92)',
                    titleColor: '#f1f5f9',
                    bodyColor: '#94a3b8',
                    borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1,
                    callbacks: {
                        label: ctx => ` ${ctx.parsed.y}${unit}`
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 6, maxRotation: 0 },
                    grid:  { color: 'rgba(255,255,255,0.04)' },
                },
                y: {
                    ticks: { color: '#64748b', font: { size: 10 } },
                    grid:  { color: 'rgba(255,255,255,0.06)' },
                }
            }
        }
    };
}

function _vizMultiChartDefaults(colors, labels, unit = '') {
    return {
        type: 'line',
        data: {
            labels: [],
            datasets: labels.map((lbl, i) => ({
                label: lbl,
                data: [],
                borderColor: colors[i],
                backgroundColor: colors[i] + '18',
                borderWidth: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                fill: false,
                tension: 0.4,
            }))
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12 }
                },
                tooltip: {
                    backgroundColor: 'rgba(10,14,26,0.92)',
                    titleColor: '#f1f5f9',
                    bodyColor: '#94a3b8',
                    borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1,
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}${unit}`
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 6, maxRotation: 0 },
                    grid:  { color: 'rgba(255,255,255,0.04)' },
                },
                y: {
                    ticks: { color: '#64748b', font: { size: 10 } },
                    grid:  { color: 'rgba(255,255,255,0.06)' },
                }
            }
        }
    };
}

function _vizInitCharts() {
    // Destroy stale instances (navigation back-and-forth)
    Object.values(_vizCharts).forEach(c => c.destroy());
    Object.keys(_vizCharts).forEach(k => delete _vizCharts[k]);

    const a1Color  = '#3b82f6';
    const a2cColor = '#00e5ff';
    const a2vColor = '#14b8a6';
    const a3Color  = '#8b5cf6';
    const rateColor = '#f59e0b';

    const get = id => document.getElementById(id);

    // A1 — Failure Probability
    if (get('viz-chart-a1')) {
        const cfg = _vizChartDefaults(a1Color, 'Failure Prob.', '%');
        cfg.options.scales.y.min = 0; cfg.options.scales.y.max = 100;
        cfg.data.labels               = [...vizData.A1.timestamps];
        cfg.data.datasets[0].data     = [...vizData.A1.failureProb];
        _vizCharts.a1 = new Chart(get('viz-chart-a1'), cfg);
    }

    // A2 — Cooler & Valve (multi-series)
    if (get('viz-chart-a2')) {
        const cfg = _vizMultiChartDefaults([a2cColor, a2vColor], ['Cooler', 'Valve'], '%');
        cfg.options.scales.y.min = 0; cfg.options.scales.y.max = 100;
        cfg.data.labels              = [...vizData.A2.timestamps];
        cfg.data.datasets[0].data    = [...vizData.A2.cooler];
        cfg.data.datasets[1].data    = [...vizData.A2.valve];
        _vizCharts.a2 = new Chart(get('viz-chart-a2'), cfg);
    }

    // A3 — Anomaly Score
    if (get('viz-chart-a3')) {
        const cfg = _vizChartDefaults(a3Color, 'Anomaly Score');
        cfg.options.scales.y.min = 0; cfg.options.scales.y.max = 1;
        // danger zone annotation via background plugin workaround
        cfg.data.labels              = [...vizData.A3.timestamps];
        cfg.data.datasets[0].data    = [...vizData.A3.anomalyScore];
        _vizCharts.a3 = new Chart(get('viz-chart-a3'), cfg);
    }

    // Msg/s rate
    if (get('viz-chart-rate')) {
        const cfg = _vizChartDefaults(rateColor, 'Messages/s', ' msg/s');
        cfg.options.scales.y.min = 0;
        cfg.data.labels              = [...vizData.msgRateTs];
        cfg.data.datasets[0].data    = [...vizData.msgRate];
        _vizCharts.rate = new Chart(get('viz-chart-rate'), cfg);
    }
}

function _vizRefreshCharts() {
    if (_vizCharts.a1) {
        _vizCharts.a1.data.labels           = [...vizData.A1.timestamps];
        _vizCharts.a1.data.datasets[0].data = [...vizData.A1.failureProb];
        _vizCharts.a1.update('none');
    }
    if (_vizCharts.a2) {
        _vizCharts.a2.data.labels           = [...vizData.A2.timestamps];
        _vizCharts.a2.data.datasets[0].data = [...vizData.A2.cooler];
        _vizCharts.a2.data.datasets[1].data = [...vizData.A2.valve];
        _vizCharts.a2.update('none');
    }
    if (_vizCharts.a3) {
        _vizCharts.a3.data.labels           = [...vizData.A3.timestamps];
        _vizCharts.a3.data.datasets[0].data = [...vizData.A3.anomalyScore];
        _vizCharts.a3.update('none');
    }
    if (_vizCharts.rate) {
        _vizCharts.rate.data.labels           = [...vizData.msgRateTs];
        _vizCharts.rate.data.datasets[0].data = [...vizData.msgRate];
        _vizCharts.rate.update('none');
    }

    // Refresh KPI strip values
    const a1Latest  = vizData.A1.failureProb.at(-1)   ?? null;
    const a2cLatest = vizData.A2.cooler.at(-1)         ?? null;
    const a2vLatest = vizData.A2.valve.at(-1)          ?? null;
    const a3Latest  = vizData.A3.anomalyScore.at(-1)   ?? null;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    // KPI strip (top)
    set('viz-kpi-a1',  a1Latest  !== null ? a1Latest.toFixed(1)  + '%'   : '—');
    set('viz-kpi-a2c', a2cLatest !== null ? a2cLatest.toFixed(0) + '%'   : '—');
    set('viz-kpi-a2v', a2vLatest !== null ? a2vLatest.toFixed(0) + '%'   : '—');
    set('viz-kpi-a3',  a3Latest  !== null ? a3Latest.toFixed(3)          : '—');

    // Chart card "Latest" stats
    set('viz-a1-latest',  a1Latest  !== null ? a1Latest.toFixed(1)  + '%'   : '—');
    set('viz-a3-latest',  a3Latest  !== null ? a3Latest.toFixed(3)          : '—');
    set('viz-a2c-latest', a2cLatest !== null ? a2cLatest.toFixed(0) + '%'   : '—');
    set('viz-a2v-latest', a2vLatest !== null ? a2vLatest.toFixed(0) + '%'   : '—');
}

function renderVisualisationPage() {
    const page = document.getElementById('page-visualisation');

    page.innerHTML = `
        <div class="page-container">
            <h1 class="page-title">
                <span class="viz-live-dot"></span>Visualisation
            </h1>

            <!-- KPI strip -->
            <div class="viz-kpi-strip">
                <div class="viz-kpi-card">
                    <div class="viz-kpi-label">A1 — Failure Prob.</div>
                    <div class="viz-kpi-value" id="viz-kpi-a1" style="color:var(--a1-color)">—</div>
                </div>
                <div class="viz-kpi-card">
                    <div class="viz-kpi-label">A2 — Cooler</div>
                    <div class="viz-kpi-value" id="viz-kpi-a2c" style="color:var(--a2-color)">—</div>
                </div>
                <div class="viz-kpi-card">
                    <div class="viz-kpi-label">A2 — Valve</div>
                    <div class="viz-kpi-value" id="viz-kpi-a2v" style="color:#14b8a6">—</div>
                </div>
                <div class="viz-kpi-card">
                    <div class="viz-kpi-label">A3 — Anomaly Score</div>
                    <div class="viz-kpi-value" id="viz-kpi-a3" style="color:var(--a3-color)">—</div>
                </div>
            </div>

            <!-- Row 1: A1 + A3 -->
            <div class="viz-grid">
                <div class="chart-card">
                    <div class="chart-card-header">
                        <div class="chart-card-title">
                            <span class="chart-dot a1"></span>
                            A1 — CNC Failure Probability
                        </div>
                        <span class="chart-card-badge">Supervised</span>
                    </div>
                    <div class="chart-canvas-wrap">
                        <canvas id="viz-chart-a1"></canvas>
                    </div>
                    <div class="chart-status-row">
                        <div class="chart-stat">
                            <span class="chart-stat-label">Latest</span>
                            <span class="chart-stat-value" id="viz-a1-latest">—</span>
                        </div>
                        <div class="chart-stat">
                            <span class="chart-stat-label">Data Points</span>
                            <span class="chart-stat-value">${vizData.A1.failureProb.length}</span>
                        </div>
                    </div>
                </div>

                <div class="chart-card">
                    <div class="chart-card-header">
                        <div class="chart-card-title">
                            <span class="chart-dot a3"></span>
                            A3 — APU Anomaly Score
                        </div>
                        <span class="chart-card-badge">Unsupervised</span>
                    </div>
                    <div class="chart-canvas-wrap">
                        <canvas id="viz-chart-a3"></canvas>
                    </div>
                    <div class="chart-status-row">
                        <div class="chart-stat">
                            <span class="chart-stat-label">Latest</span>
                            <span class="chart-stat-value" id="viz-a3-latest">—</span>
                        </div>
                        <div class="chart-stat">
                            <span class="chart-stat-label">Threshold</span>
                            <span class="chart-stat-value">0.400</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Row 2: A2 full width -->
            <div class="viz-grid-full">
                <div class="chart-card">
                    <div class="chart-card-header">
                        <div class="chart-card-title">
                            <span class="chart-dot a2"></span>
                            A2 — Hydraulic System Condition
                        </div>
                        <span class="chart-card-badge">Multi-target</span>
                    </div>
                    <div class="chart-canvas-wrap" style="height:200px">
                        <canvas id="viz-chart-a2"></canvas>
                    </div>
                    <div class="chart-status-row">
                        <div class="chart-stat">
                            <span class="chart-stat-label">Cooler (latest)</span>
                            <span class="chart-stat-value" id="viz-a2c-latest">—</span>
                        </div>
                        <div class="chart-stat">
                            <span class="chart-stat-label">Valve (latest)</span>
                            <span class="chart-stat-value" id="viz-a2v-latest">—</span>
                        </div>
                        <div class="chart-stat">
                            <span class="chart-stat-label">Data Points</span>
                            <span class="chart-stat-value">${vizData.A2.timestamps.length}</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Row 3: MQTT message rate -->
            <div class="viz-grid-full">
                <div class="chart-card">
                    <div class="chart-card-header">
                        <div class="chart-card-title">
                            <span class="chart-dot" style="background:var(--accent-amber)"></span>
                            MQTT — Message Rate
                        </div>
                        <span class="chart-card-badge">Broker</span>
                    </div>
                    <div class="chart-canvas-wrap" style="height:140px">
                        <canvas id="viz-chart-rate"></canvas>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Initialise charts after DOM is painted
    requestAnimationFrame(() => {
        _vizInitCharts();
        _vizRefreshCharts();
    });
}

function renderOverviewPage() {
    const page = document.getElementById('page-overview');

    // Build asset rows dynamically
    const assetDefs = [
        { id: 'a1', label: 'A1 — CNC Milling',      zone: 'Workshop Zone 1' },
        { id: 'a2', label: 'A2 — Hydraulic System',  zone: 'Workshop Zone 1' },
        { id: 'a3', label: 'A3 — APU Compressor',    zone: 'Workshop Zone 2' },
    ];

    page.innerHTML = `
        <div class="page-container">
            <h1 class="page-title">Overview</h1>

            <!-- Live KPI strip -->
            <div class="kpi-grid">
                <div class="kpi-card">
                    <div class="kpi-card-label">Session Uptime</div>
                    <div class="kpi-card-value" id="ov-uptime" style="color:var(--accent-cyan)">—</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">MQTT Messages</div>
                    <div class="kpi-card-value" id="ov-msgs" style="color:var(--accent-cyan)">—</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Active Alerts</div>
                    <div class="kpi-card-value" id="ov-alerts">—</div>
                </div>
            </div>

            <!-- Asset status cards -->
            <h2 class="section-title">Asset Status</h2>
            <div class="asset-grid">
                ${assetDefs.map(a => `
                    <div class="asset-status-card" onclick="navigateToPage('live')">
                        <div class="asset-status-header">
                            <div class="asset-status-name">${a.label}</div>
                            <span class="status-badge warning" id="ov-badge-${a.id}">Initializing</span>
                        </div>
                        <p style="color:var(--text-muted);font-size:13px;margin:6px 0 2px">${a.zone}</p>
                        <p style="color:var(--text-muted);font-size:12px">
                            Last data: <span id="ov-lastseen-${a.id}" style="color:var(--text-secondary)">No data yet</span>
                        </p>
                    </div>
                `).join('')}
            </div>

            <!-- Recent activity (live) -->
            <h2 class="section-title">Recent Activity</h2>
            <div class="activity-log" id="ov-activity-log">
                <div class="activity-item">
                    <span class="activity-text" style="color:var(--text-muted)">Waiting for MQTT data...</span>
                </div>
            </div>
        </div>
    `;

    // Immediate fill + start live refresh
    _refreshOverviewDynamic();
}

function renderAnalyticsPage() {
    const page = document.getElementById('page-analytics');

    // ── Real model metrics extracted from notebooks ──────────────────
    const models = [
        {
            name: 'CNC Failure Predictor',
            asset: 'A1', color: 'var(--a1-color)',
            type: 'Binary Classification',
            algo: 'XGBoost + SMOTE',
            dataset: 'AI4I 2020 (10 000 samples, 3.4% failure rate)',
            accuracy: '97.05%', f1: '82.75% (macro) / 67.04% (binary)', precision: '54.05%', recall: '88.24%',
            note: 'ROC-AUC = 0.9845 · Avg Precision = 0.8657. High recall (88%) is the priority given the cost of missed failures. Low precision reflects the 28.5:1 class imbalance.',
            status: 'active',
        },
        {
            name: 'Hydraulic Condition Monitor',
            asset: 'A2', color: 'var(--a2-color)',
            type: 'Multi-target Classification',
            algo: 'XGBoost (4 targets)',
            dataset: 'ZeMA Hydraulic (2 205 samples)',
            accuracy: 'Cooler 100% / Valve 98.9% / Pump 99.6% / Accum. 100%',
            f1: 'Cooler 100% / Valve 98.7% / Pump 99.6% / Accum. 100%',
            precision: '99–100%', recall: '99–100%',
            note: 'All 4 targets pass validation (≥98% macro-F1)',
            status: 'active',
        },
        {
            name: 'APU Anomaly Detector',
            asset: 'A3', color: 'var(--a3-color)',
            type: 'Unsupervised Anomaly Detection',
            algo: 'Isolation Forest + LSTM Autoencoder (Ensemble)',
            dataset: 'MetroPT-3 APU (1 516 948 samples)',
            accuracy: '4/4 failure windows detected',
            f1: '52.2% @ 96th-percentile threshold',
            precision: '49.3%', recall: '55.4%',
            note: 'Best ensemble threshold: 96th percentile. All 4 historical failure windows detected.',
            status: 'active',
        },
    ];

    // Live MQTT telemetry — read from vizData ring buffers (always up to date)
    const liveA1  = vizData.A1.failureProb.length   ? vizData.A1.failureProb.at(-1).toFixed(1) + '%' : (document.getElementById('a1-prob')?.textContent  || '—');
    const liveA2c = vizData.A2.cooler.length         ? vizData.A2.cooler.at(-1).toFixed(0)      + '%' : (document.getElementById('a2-cooler')?.textContent || '—');
    const liveA2v = vizData.A2.valve.length          ? vizData.A2.valve.at(-1).toFixed(0)       + '%' : (document.getElementById('a2-valve')?.textContent  || '—');
    const liveA3  = vizData.A3.anomalyScore.length   ? vizData.A3.anomalyScore.at(-1).toFixed(3)      : (document.getElementById('a3-score')?.textContent  || '—');

    page.innerHTML = `
        <div class="page-container">
            <h1 class="page-title">Analytics</h1>

            <!-- Live inference KPIs — IDs allow onMessageArrived to keep them updated -->
            <h2 class="section-title">Live Inference Values</h2>
            <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">
                <div class="kpi-card">
                    <div class="kpi-card-label">A1 — Failure Prob.</div>
                    <div class="kpi-card-value" id="an-kpi-a1" style="color:var(--a1-color);font-size:22px">${liveA1}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">A2 — Cooler</div>
                    <div class="kpi-card-value" id="an-kpi-a2c" style="color:var(--a2-color);font-size:22px">${liveA2c}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">A2 — Valve</div>
                    <div class="kpi-card-value" id="an-kpi-a2v" style="color:var(--a2-color);font-size:22px">${liveA2v}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">A3 — Anomaly Score</div>
                    <div class="kpi-card-value" id="an-kpi-a3" style="color:var(--a3-color);font-size:22px">${liveA3}</div>
                </div>
            </div>

            <!-- Model registry -->
            <h2 class="section-title">Model Registry</h2>
            <table class="model-table">
                <thead>
                    <tr>
                        <th>Model</th>
                        <th>Asset</th>
                        <th>Algorithm</th>
                        <th>Dataset</th>
                        <th>Accuracy</th>
                        <th>Macro F1</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${models.map(m => `
                        <tr>
                            <td style="font-weight:600;color:${m.color}">${m.name}</td>
                            <td>${m.asset}</td>
                            <td>${m.algo}</td>
                            <td style="font-size:12px;color:var(--text-muted)">${m.dataset}</td>
                            <td style="font-size:12px">${m.accuracy}</td>
                            <td style="font-size:12px">${m.f1}</td>
                            <td><span class="status-badge healthy">${m.status}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>

            <!-- Per-model detail cards -->
            <h2 class="section-title">Model Details</h2>
            <div style="display:flex;flex-direction:column;gap:16px;margin-bottom:24px">
                ${models.map(m => `
                    <div class="kpi-card" style="border-left:3px solid ${m.color}">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                            <div>
                                <span style="font-weight:600;color:${m.color};font-size:15px">${m.name}</span>
                                <span style="margin-left:10px;font-size:12px;color:var(--text-muted)">${m.type}</span>
                            </div>
                            <span class="status-badge healthy">Active</span>
                        </div>
                        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:10px">
                            <div>
                                <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">Accuracy</div>
                                <div style="font-size:13px;font-weight:600;font-family:var(--font-mono)">${m.accuracy}</div>
                            </div>
                            <div>
                                <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">Macro F1</div>
                                <div style="font-size:13px;font-weight:600;font-family:var(--font-mono)">${m.f1}</div>
                            </div>
                            <div>
                                <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">Precision</div>
                                <div style="font-size:13px;font-weight:600;font-family:var(--font-mono)">${m.precision}</div>
                            </div>
                            <div>
                                <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">Recall</div>
                                <div style="font-size:13px;font-weight:600;font-family:var(--font-mono)">${m.recall}</div>
                            </div>
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:8px">
                            ℹ ${m.note}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

const documentationMarkdown = `
# Documentation

Welcome to the JESA Digital Twin technical documentation.

## <a id="architecture">System Architecture</a>

The JESA Digital Twin system consists of three main components:

1. **3D Visualization Layer**: Real-time 3D representation of the factory floor using Three.js
2. **MQTT Data Pipeline**: Real-time data ingestion from sensors and edge devices
3. **Analytics Backend**: Machine learning models for predictive maintenance and anomaly detection

## <a id="assets">Sensor / Asset Reference</a>

### Asset A1: CNC Milling Machine
- **Location**: Workshop Zone 1
- **Sensors**: Vibration, Temperature, Current
- **Data Frequency**: 100 Hz

### Asset A2: Hydraulic System
- **Location**: Workshop Zone 1
- **Sensors**: Pressure, Temperature, Flow Rate
- **Data Frequency**: 50 Hz

### Asset A3: APU Compressor
- **Location**: Workshop Zone 2
- **Sensors**: Vibration, Acoustic Emission
- **Data Frequency**: 200 Hz

## <a id="mqtt">MQTT Topic Schema</a>

\`\`\`
jesa/
└── site1/
    └── workshop/
        ├── milling/
        │   └── A1/
        │       ├── analytics/
        │       │   └── machine_failure
        │       └── status/
        │           └── machine_failure
        ├── hydraulics/
        │   └── A2/
        │       ├── analytics/
        │       │   ├── cooler_condition
        │       │   └── valve_condition
        │       └── condition/
        │           ├── cooler_condition_pct
        │           └── valve_condition_pct
        └── fleet/
            └── A3/
                └── analytics/
                    └── anomaly
\`\`\`

## <a id="alerts">Alert Thresholds & Definitions</a>

| Alert Level | Failure Probability | Anomaly Score |
|-------------|---------------------|---------------|
| Healthy     | < 5%                | < 0.4         |
| Warning     | 5% - 20%            | 0.4 - 0.7     |
| Critical    | > 20%               | > 0.7         |

## <a id="troubleshooting">Troubleshooting</a>

### MQTT Connection Issues

If you see "MQTT failed: AMQJS0007E Socket error", check:

1. That the MQTT broker is running on localhost:9001
2. That there are no firewall rules blocking the connection
3. That the broker allows WebSocket connections
`;

function renderDocumentationPage() {
    const page = document.getElementById('page-docs');
    
    page.innerHTML = `
        <div class="page-container">
            <h1 class="page-title">Documentation</h1>
            
            <div class="docs-container">
                <div class="docs-sidebar">
                    <input type="text" class="docs-search" id="docs-search" placeholder="Search documentation...">
                    <div id="docs-toc">
                        <div class="docs-toc-item active" data-section="all">All Sections</div>
                        <div class="docs-toc-item" data-section="architecture">System Architecture</div>
                        <div class="docs-toc-item" data-section="assets">Sensor / Asset Reference</div>
                        <div class="docs-toc-item" data-section="mqtt">MQTT Topic Schema</div>
                        <div class="docs-toc-item" data-section="alerts">Alert Thresholds & Definitions</div>
                        <div class="docs-toc-item" data-section="troubleshooting">Troubleshooting</div>
                    </div>
                </div>
                <div class="docs-content" id="docs-content">
                    ${marked.parse(documentationMarkdown)}
                </div>
            </div>
        </div>
    `;

    // Add search functionality
    const searchInput = document.getElementById('docs-search');
    const tocItems = document.querySelectorAll('.docs-toc-item');
    
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const content = document.getElementById('docs-content');
        
        if (query) {
            content.innerHTML = marked.parse(documentationMarkdown).toLowerCase().includes(query) 
                ? marked.parse(documentationMarkdown) 
                : '<p style="color: var(--text-muted)">No results found.</p>';
        } else {
            content.innerHTML = marked.parse(documentationMarkdown);
        }
    });

    // Add TOC click functionality
    tocItems.forEach(item => {
        item.addEventListener('click', () => {
            tocItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            const section = item.dataset.section;
            if (section === 'all') {
                // Scroll to top
                const docsContent = document.getElementById('docs-content');
                docsContent.scrollTop = 0;
            } else {
                const targetElement = document.getElementById(section);
                if (targetElement) {
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        });
    });
}

// =====================================================================
//  SCENE SETUP
// =====================================================================
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f172a);
scene.fog = new THREE.FogExp2(0x0f172a, 0.008);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 18, 50);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

// Post-processing
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.8, 0.4, 0.85);
bloom.threshold = 0.35;
bloom.strength = 0.7;
bloom.radius = 0.4;
composer.addPass(bloom);

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI / 2 - 0.08;
controls.minDistance = 15;
controls.maxDistance = 80;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.3;
controls.target.set(0, 4, 0);

// =====================================================================
//  LIGHTING — Industrial feel
// =====================================================================
scene.add(new THREE.AmbientLight(0xffffff, 1.2));

const keyLight = new THREE.DirectionalLight(0xdde4ff, 2.5);
keyLight.position.set(25, 35, 20);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -30; keyLight.shadow.camera.right = 30;
keyLight.shadow.camera.top = 30;   keyLight.shadow.camera.bottom = -30;
keyLight.shadow.bias = -0.0002;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x4488ff, 0.8);
fillLight.position.set(-15, 10, -10);
scene.add(fillLight);

const rimLight = new THREE.PointLight(0x00e5ff, 4, 60);
rimLight.position.set(-20, 8, 15);
scene.add(rimLight);

const rimLight2 = new THREE.PointLight(0x7b61ff, 3, 50);
rimLight2.position.set(20, 6, -10);
scene.add(rimLight2);

// =====================================================================
//  ENVIRONMENT
// =====================================================================
// Ground
const groundMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.85, metalness: 0.1 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 5;
ground.receiveShadow = true;
scene.add(ground);
window._ground = ground; // exposed for panel lift

// Grid
const grid = new THREE.GridHelper(120, 60, 0x00e5ff, 0x0a1530);
grid.position.y = 5.02;
grid.material.opacity = 0.12;
grid.material.transparent = true;
scene.add(grid);
window._grid = grid; // exposed for panel lift

// Subtle particles
const pCount = 600;
const pPos = new Float32Array(pCount * 3);
for (let i = 0; i < pCount * 3; i++) pPos[i] = (Math.random() - 0.5) * 80;
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
const pMat = new THREE.PointsMaterial({ size: 0.08, color: 0x00e5ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending });
const particles = new THREE.Points(pGeo, pMat);
particles.position.y = 15;
scene.add(particles);

// =====================================================================
//  MATERIALS LIBRARY
// =====================================================================
const MAT = {
    body:   () => new THREE.MeshStandardMaterial({ color: 0x3a4055, metalness: 0.7, roughness: 0.35 }),
    panel:  () => new THREE.MeshStandardMaterial({ color: 0x2a2e3e, metalness: 0.3, roughness: 0.6 }),
    dark:   () => new THREE.MeshStandardMaterial({ color: 0x1a1e2a, metalness: 0.5, roughness: 0.5 }),
    accent: (c) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.2, roughness: 0.3 }),
    glow:   (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.9, metalness: 0.1, roughness: 0.2 }),
    glass:  () => new THREE.MeshStandardMaterial({ color: 0x1a3050, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.4 }),
    chrome: () => new THREE.MeshStandardMaterial({ color: 0x888899, metalness: 0.95, roughness: 0.08 }),
    rubber: () => new THREE.MeshStandardMaterial({ color: 0x151515, metalness: 0.0, roughness: 0.95 }),
    pipe:   (c) => new THREE.MeshStandardMaterial({ color: c || 0x556677, metalness: 0.6, roughness: 0.3 }),
};

const COLORS = {
    good: 0x00e676, warning: 0xffab00, critical: 0xff1744,
    a1: 0x4d7cfe, a2: 0x00e5ff, a3: 0x7b61ff
};

// =====================================================================
//  ASSET STATE TRACKING
// =====================================================================
const assets = {
    A1: { group: null, glowParts: [], statusColor: COLORS.a1 },
    A2: { group: null, glowParts: [], statusColor: COLORS.a2 },
    A3: { group: null, glowParts: [], statusColor: COLORS.a3 },
};

const assetTelemetry = {
    A1: { lastSeen: 0, updates: 0 },
    A2: { lastSeen: 0, updates: 0 },
    A3: { lastSeen: 0, updates: 0 },
};

const STALE_MS = { A1: 8000, A2: 70000, A3: 20000 };

// =====================================================================
//  A1 — CNC MILLING MACHINE (Detailed)
// =====================================================================
function buildA1() {
    const g = new THREE.Group();

    // === Main Enclosure ===
    const enclosure = new THREE.Mesh(new THREE.BoxGeometry(6, 5.5, 5), MAT.body());
    enclosure.position.set(0, 2.75, 0);
    enclosure.castShadow = true; enclosure.receiveShadow = true;
    g.add(enclosure);

    // Front window (glass panel)
    const glass = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3, 0.1), MAT.glass());
    glass.position.set(0, 3.2, 2.51);
    g.add(glass);

    // Window frame
    const frameMat = MAT.chrome();
    const frameTop = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.12, 0.15), frameMat);
    frameTop.position.set(0, 4.75, 2.52); g.add(frameTop);
    const frameBot = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.12, 0.15), frameMat);
    frameBot.position.set(0, 1.65, 2.52); g.add(frameBot);
    const frameL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3.22, 0.15), frameMat);
    frameL.position.set(-2.35, 3.2, 2.52); g.add(frameL);
    const frameR = frameL.clone(); frameR.position.x = 2.35; g.add(frameR);

    // === Spindle Head (on top) ===
    const spindleHousing = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.8, 2.5), MAT.panel());
    spindleHousing.position.set(0, 6.4, 0);
    spindleHousing.castShadow = true;
    g.add(spindleHousing);

    // Z-axis rail
    const zRail = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 2, 16), MAT.chrome());
    zRail.position.set(-0.6, 6.4, 0.8); g.add(zRail);
    const zRail2 = zRail.clone(); zRail2.position.x = 0.6; g.add(zRail2);

    // Spindle motor
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.4, 24), MAT.dark());
    motor.position.set(0, 7.6, 0); g.add(motor);

    // Spindle collet/tool
    const collet = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.08, 0.6, 12), MAT.chrome());
    collet.position.set(0, 5.2, 0); g.add(collet);

    // === Work Table ===
    const table = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.25, 3.5), MAT.chrome());
    table.position.set(0, 0.5, 0);
    table.castShadow = true; table.receiveShadow = true;
    g.add(table);

    // T-slot lines on table
    for (let i = -1.2; i <= 1.2; i += 0.6) {
        const slot = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.05, 0.08), MAT.dark());
        slot.position.set(0, 0.64, i); g.add(slot);
    }

    // === Control Panel (right side) ===
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3, 2.5), MAT.panel());
    panel.position.set(3.5, 2.5, 0);
    panel.castShadow = true;
    g.add(panel);

    // Screen on panel
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.5, 1.5), MAT.glow(0x1a3a5a));
    screen.position.set(3.77, 3.2, 0); g.add(screen);

    // Buttons
    for (let j = 0; j < 3; j++) {
        const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 12), MAT.accent(j === 0 ? 0x00e676 : j === 1 ? 0xffab00 : 0xff1744));
        btn.rotation.z = Math.PI / 2;
        btn.position.set(3.78, 2.0, -0.4 + j * 0.4);
        g.add(btn);
    }

    // === Base / Machine Bed ===
    const bed = new THREE.Mesh(new THREE.BoxGeometry(7, 0.4, 6), MAT.dark());
    bed.position.set(0, 0.2, 0);
    bed.receiveShadow = true;
    g.add(bed);

    // Leveling feet
    for (const [x, z] of [[-3, -2.5], [3, -2.5], [-3, 2.5], [3, 2.5]]) {
        const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 0.15, 16), MAT.rubber());
        foot.position.set(x, 0.05, z); g.add(foot);
    }

    // === Status LED Ring (holographic ring on base) ===
    const glowMat = MAT.glow(COLORS.a1);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.06, 16, 80), glowMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    g.add(ring);

    // Floating label ring
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.02, 8, 80), MAT.glow(COLORS.a1));
    ring2.rotation.x = -Math.PI / 2;
    ring2.position.y = 0.6;
    g.add(ring2);

    assets.A1.group = g;
    assets.A1.glowParts = [glowMat, ring2.material];
    g.position.set(-18, 5, 0);
    scene.add(g);
}

// =====================================================================
//  A2 — HYDRAULIC POWER UNIT (Detailed)
// =====================================================================
function buildA2() {
    const g = new THREE.Group();

    // === Main Reservoir Tank (vertical cylinder) ===
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 5, 32), MAT.body());
    tank.position.set(0, 2.8, 0);
    tank.castShadow = true; tank.receiveShadow = true;
    g.add(tank);

    // Tank top cap
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, 0.2, 32), MAT.panel());
    cap.position.set(0, 5.4, 0); g.add(cap);

    // Fill port on top
    const fillPort = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.3, 16), MAT.chrome());
    fillPort.position.set(0.8, 5.65, 0); g.add(fillPort);

    // Sight glass (oil level indicator)
    const sightGlass = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 2.5, 12), MAT.glass());
    sightGlass.position.set(2.22, 2.8, 0); g.add(sightGlass);

    // === Motor-Pump Assembly (side) ===
    const motorBody = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 2.8, 24), MAT.dark());
    motorBody.rotation.z = Math.PI / 2;
    motorBody.position.set(0, 1.5, -3.2);
    motorBody.castShadow = true;
    g.add(motorBody);

    // Motor end cap
    const endCap = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.15, 24), MAT.panel());
    endCap.rotation.z = Math.PI / 2;
    endCap.position.set(-1.5, 1.5, -3.2); g.add(endCap);

    // Coupling housing
    const coupling = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.5, 16), MAT.chrome());
    coupling.rotation.z = Math.PI / 2;
    coupling.position.set(1.6, 1.5, -3.2); g.add(coupling);

    // Motor cooling fins
    for (let i = -1; i <= 1; i += 0.25) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 2.4, 0.04), MAT.panel());
        fin.position.set(i, 1.5, -3.2 + 1.2); g.add(fin);
    }

    // === Manifold Block ===
    const manifold = new THREE.Mesh(new THREE.BoxGeometry(3, 1.5, 1.5), MAT.panel());
    manifold.position.set(0, 1.2, 3);
    manifold.castShadow = true;
    g.add(manifold);

    // Solenoid valves on manifold
    for (let i = -1; i <= 1; i++) {
        const valve = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.4), MAT.dark());
        valve.position.set(i, 2.2, 3); g.add(valve);
        const coil = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.6, 12), MAT.accent(0x445566));
        coil.position.set(i, 2.8, 3); g.add(coil);
    }

    // === Pressure Lines (pipes between tank and manifold) ===
    const pipeMat = MAT.pipe(0x667788);
    // Supply line
    const supplyPath = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
            new THREE.Vector3(1.5, 2.5, 1.1),
            new THREE.Vector3(1.8, 2.5, 2.0),
            new THREE.Vector3(1.5, 2.0, 2.8),
        ]), 20, 0.12, 8, false
    );
    g.add(new THREE.Mesh(supplyPath, pipeMat));

    // Return line
    const returnPath = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
            new THREE.Vector3(-1.5, 3.5, 1.1),
            new THREE.Vector3(-1.8, 3.5, 2.0),
            new THREE.Vector3(-1.5, 2.0, 2.8),
        ]), 20, 0.12, 8, false
    );
    g.add(new THREE.Mesh(returnPath, pipeMat));

    // === Pressure Gauge ===
    const gaugeBody = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.15, 24), MAT.chrome());
    gaugeBody.rotation.x = Math.PI / 2;
    gaugeBody.position.set(0, 3.5, 3.85); g.add(gaugeBody);
    const gaugeFace = new THREE.Mesh(new THREE.CircleGeometry(0.35, 24), new THREE.MeshStandardMaterial({ color: 0xf0f0e0, roughness: 0.9 }));
    gaugeFace.position.set(0, 3.5, 3.93); g.add(gaugeFace);

    // === Filter Housing ===
    const filter = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.8, 16), MAT.accent(0x334455));
    filter.position.set(-2.8, 1.5, -1); g.add(filter);
    const filterCap = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 16), MAT.chrome());
    filterCap.position.set(-2.8, 2.45, -1); g.add(filterCap);

    // === Base Frame ===
    const frame = new THREE.Mesh(new THREE.BoxGeometry(8, 0.3, 8), MAT.dark());
    frame.position.set(0, 0.15, 0);
    frame.receiveShadow = true;
    g.add(frame);

    // === Status LED Rings ===
    const glowMat = MAT.glow(COLORS.a2);
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(5, 0.06, 16, 80), glowMat);
    r1.rotation.x = -Math.PI / 2; r1.position.y = 0.05; g.add(r1);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(5, 0.02, 8, 80), MAT.glow(COLORS.a2));
    r2.rotation.x = -Math.PI / 2; r2.position.y = 0.5; g.add(r2);

    assets.A2.group = g;
    assets.A2.glowParts = [glowMat, r2.material];
    g.position.set(0, 5, 0);
    scene.add(g);
}

// =====================================================================
//  A3 — APU COMPRESSOR / TURBINE (Detailed)
// =====================================================================
function buildA3() {
    const g = new THREE.Group();

    // === Main Turbine Housing (horizontal cylinder) ===
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.0, 7, 32), MAT.body());
    housing.rotation.z = Math.PI / 2;
    housing.position.set(0, 2.5, 0);
    housing.castShadow = true; housing.receiveShadow = true;
    g.add(housing);

    // === Air Intake Cone (left side) ===
    const intake = new THREE.Mesh(new THREE.ConeGeometry(2.3, 1.5, 32), MAT.panel());
    intake.rotation.z = Math.PI / 2;
    intake.position.set(-4.2, 2.5, 0);
    g.add(intake);

    // Intake screen/grille
    const intakeRing = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.1, 8, 32), MAT.chrome());
    intakeRing.rotation.y = Math.PI / 2;
    intakeRing.position.set(-4.9, 2.5, 0);
    g.add(intakeRing);

    // Intake vanes
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
        const vane = new THREE.Mesh(new THREE.BoxGeometry(0.05, 3.6, 0.15), MAT.chrome());
        vane.position.set(-4.85, 2.5, 0);
        vane.rotation.x = a;
        g.add(vane);
    }

    // === Exhaust Section (right side) ===
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.2, 1.5, 32), MAT.dark());
    exhaust.rotation.z = Math.PI / 2;
    exhaust.position.set(4.2, 2.5, 0);
    g.add(exhaust);

    // Exhaust nozzle ring
    const nozzleRing = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.08, 8, 32), MAT.glow(0x331100));
    nozzleRing.rotation.y = Math.PI / 2;
    nozzleRing.position.set(4.95, 2.5, 0);
    g.add(nozzleRing);

    // === Compressor Stages (visible rings along housing) ===
    for (let x = -2.5; x <= 2.5; x += 1) {
        const stageRing = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.08, 16, 32), MAT.panel());
        stageRing.rotation.y = Math.PI / 2;
        stageRing.position.set(x, 2.5, 0);
        g.add(stageRing);
    }

    // === Accessory Gearbox (bottom) ===
    const gearbox = new THREE.Mesh(new THREE.BoxGeometry(3, 1.2, 2.5), MAT.panel());
    gearbox.position.set(0, 0.8, -1.8);
    gearbox.castShadow = true;
    g.add(gearbox);

    // Generator (cylinder on gearbox)
    const gen = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.5, 20), MAT.dark());
    gen.rotation.z = Math.PI / 2;
    gen.position.set(0, 1.8, -2.8);
    g.add(gen);

    // === Oil Lines ===
    const oilPath = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
            new THREE.Vector3(-1.0, 0.5, -0.8),
            new THREE.Vector3(-1.5, 0.3, 0),
            new THREE.Vector3(-1.0, 0.5, 0.8),
        ]), 20, 0.08, 8, false
    );
    g.add(new THREE.Mesh(oilPath, MAT.pipe(0x556633)));

    // === Mounting Bolts ===
    for (const [x, z] of [[-2.5, 2], [2.5, 2], [-2.5, -2], [2.5, -2]]) {
        const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.2, 8), MAT.chrome());
        bolt.position.set(x, 0.1, z); g.add(bolt);
    }

    // === Cooling Fins (top) ===
    for (let x = -2; x <= 2; x += 0.4) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 3), MAT.panel());
        fin.position.set(x, 4.5, 0); g.add(fin);
    }

    // === Base Frame ===
    const frame = new THREE.Mesh(new THREE.BoxGeometry(10, 0.3, 7), MAT.dark());
    frame.position.set(0, 0.15, 0);
    frame.receiveShadow = true;
    g.add(frame);

    // === Status LED Rings ===
    const glowMat = MAT.glow(COLORS.a3);
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(5.5, 0.06, 16, 80), glowMat);
    r1.rotation.x = -Math.PI / 2; r1.position.y = 0.05; g.add(r1);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(5.5, 0.02, 8, 80), MAT.glow(COLORS.a3));
    r2.rotation.x = -Math.PI / 2; r2.position.y = 0.5; g.add(r2);

    assets.A3.group = g;
    assets.A3.glowParts = [glowMat, r2.material];
    g.position.set(20, 5, 0);
    scene.add(g);
}

// Build all
buildA1();
buildA2();
buildA3();

// =====================================================================
//  ANIMATION
// =====================================================================
const clock = new THREE.Clock();
let a3Vibration = 0;

function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    controls.update();
    particles.rotation.y = t * 0.03;

    // Pulsing glow
    const pulse = Math.sin(t * 2.5) * 0.15 + 0.85;
    for (const id of ['A1', 'A2', 'A3']) {
        assets[id].glowParts.forEach(m => { m.emissiveIntensity = pulse; });
    }

    // A3 vibration
    if (a3Vibration > 0) {
        assets.A3.group.position.x = 20 + (Math.random() - 0.5) * a3Vibration;
        assets.A3.group.position.z = (Math.random() - 0.5) * a3Vibration;
    } else {
        assets.A3.group.position.x = 20;
        assets.A3.group.position.z = 0;
    }

    composer.render();
}
animate();

// Resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

// =====================================================================
//  MQTT CONNECTION
// =====================================================================
const mqttBadge = document.getElementById('mqtt-status');
const mqttDot   = mqttBadge.querySelector('.conn-dot');
const mqttText  = mqttBadge.querySelector('.conn-text');
let msgCount = 0;
const startTime = Date.now();
let client = null;

function buildClient() {
    client = new Paho.Client("127.0.0.1", 9001, "/", "jesa_twin_" + Math.random().toString(36).substring(2, 9));
    client.onConnectionLost = onConnectionLost;
    client.onMessageArrived = onMessageArrived;
}

function connectClient() {
    if (!client) buildClient();
    client.connect({
        onSuccess: onConnect,
        onFailure: onFailure,
        reconnect: true,
        keepAliveInterval: 30,
    });
}

buildClient();
connectClient();

function onConnect() {
        console.log('%c✓ MQTT Connected', 'color:#00e676;font-weight:bold');
        mqttBadge.className = 'conn-badge live';
        mqttText.textContent = 'Live';
        _logEvent('MQTT broker connected', 'info');

        client.subscribe('jesa/site1/workshop/milling/A1/#');
        client.subscribe('jesa/site1/workshop/hydraulics/A2/#');
        client.subscribe('jesa/site1/fleet/apu/A3/#');
    }

function onFailure(err) {
    console.error('MQTT failed:', err.errorMessage);
    mqttBadge.className = 'conn-badge offline';
    mqttText.textContent = 'Offline';
    _logEvent('MQTT connection failed: ' + err.errorMessage, 'critical');
}

function onConnectionLost(resp) {
    if (resp.errorCode !== 0) {
        console.warn('MQTT lost:', resp.errorMessage);
        mqttBadge.className = 'conn-badge offline';
        mqttText.textContent = 'Offline';
        _logEvent('MQTT connection lost', 'warning');
    }
}

// =====================================================================
//  HELPER UI FUNCTIONS
// =====================================================================
function setChip(id, text, cls) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'status-chip ' + cls;
}

function setCardGlow(cardId, cls) {
    const el = document.getElementById(cardId);
    el.className = 'asset-card ' + cls;
}

function setAssetGlow(assetId, colorHex) {
    assets[assetId].glowParts.forEach(m => {
        m.color.setHex(colorHex);
        m.emissive.setHex(colorHex);
    });
}

function markAssetSeen(assetId) {
    const entry = assetTelemetry[assetId];
    entry.lastSeen = Date.now();
    entry.updates += 1;
}

function formatLastSeen(assetId) {
    const lastSeen = assetTelemetry[assetId].lastSeen;
    if (!lastSeen) return 'Waiting for data';
    const ageSec = Math.max(0, Math.floor((Date.now() - lastSeen) / 1000));
    return ageSec === 0 ? 'just now' : `${ageSec}s ago`;
}

function refreshTelemetryHealth() {
    let online = 0;
    for (const assetId of ['A1', 'A2', 'A3']) {
        const age = assetTelemetry[assetId].lastSeen ? Date.now() - assetTelemetry[assetId].lastSeen : Infinity;
        document.getElementById(`${assetId.toLowerCase()}-last`).textContent = formatLastSeen(assetId);
        if (age <= STALE_MS[assetId]) {
            online += 1;
        } else if (assetTelemetry[assetId].updates > 0) {
            setChip(`${assetId.toLowerCase()}-chip`, 'Stale', 'warning');
            setCardGlow(`card-${assetId.toLowerCase()}`, 'asset-card warning-glow');
        }
    }
    document.getElementById('assets-online').textContent = `${online}/3`;
}

function resetCamera() {
    // If scene was physically lifted, bring it back down
    if (sceneLiftedCount > 0) {
        _applyPanelLift(-PANEL_LIFT * sceneLiftedCount);
        sceneLiftedCount = 0;
        panelLiftActive = false;
    }
    controls.autoRotate = true;
    controls.target.set(0, 4, 0);
    camera.position.set(0, 18, 50);
    document.querySelectorAll('.asset-card').forEach(c => c.style.outline = 'none');
}

// Uptime timer
setInterval(() => {
    const sec = Math.floor((Date.now() - startTime) / 1000);
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    document.getElementById('uptime').textContent = m + ':' + s;
}, 1000);

// Refresh overview KPIs every second when on that page
setInterval(() => {
    if (currentPage === 'overview') _refreshOverviewDynamic();
}, 1000);

setInterval(refreshTelemetryHealth, 2000);

// =====================================================================
//  MESSAGE HANDLER
// =====================================================================
function onMessageArrived(message) {
    const topic = message.destinationName;
    msgCount++;
    document.getElementById('msg-count').textContent = msgCount.toLocaleString();

    try {
        const payload = JSON.parse(message.payloadString);
        const v = payload.v;

        // Mark any asset as seen when we get any of its topics
        if (topic.includes('/A1/')) markAssetSeen('A1');
        if (topic.includes('/A2/')) markAssetSeen('A2');
        if (topic.includes('/A3/')) markAssetSeen('A3');

        // ── A1 Milling ──
        if (topic.includes('/A1/analytics/machine_failure') || topic.includes('/A1/status/machine_failure')) {
            const failureProbability = payload.probability ?? ((v === 1 || v === true) ? 1 : 0);
            const prob = (Number(failureProbability) * 100).toFixed(1);
            document.getElementById('a1-prob').textContent = prob + '%';
            document.getElementById('a1-bar').style.width = prob + '%';

            if (v === 1 || v === true) {
                document.getElementById('a1-status').textContent = 'FAILURE';
                document.getElementById('a1-status').className = 'gauge-value critical';
                document.getElementById('a1-prob').className = 'gauge-value mono critical';
                setChip('a1-chip', 'Critical', 'critical');
                setCardGlow('card-a1', 'asset-card critical-glow');
                setAssetGlow('A1', COLORS.critical);
                document.getElementById('a1-bar').style.background = 'linear-gradient(90deg, #ff1744, #ff5252)';
                _logEvent(`A1 — Machine FAILURE detected (prob: ${prob}%)`, 'critical');
            } else {
                document.getElementById('a1-status').textContent = 'HEALTHY';
                document.getElementById('a1-status').className = 'gauge-value good';
                document.getElementById('a1-prob').className = 'gauge-value mono';
                setChip('a1-chip', 'Healthy', 'healthy');
                setCardGlow('card-a1', 'asset-card healthy-glow');
                setAssetGlow('A1', COLORS.good);
                document.getElementById('a1-bar').style.background = 'linear-gradient(90deg, var(--a1-color), #6c9bff)';
                _logEvent(`A1 — Failure probability updated: ${prob}%`, 'info');
            }
            // ── Viz ring buffer push ──
            _vizPush(vizData.A1.failureProb, parseFloat(prob) || 0);
            _vizPush(vizData.A1.timestamps,  _vizTimestamp());
        }

        // ── A2 Hydraulics ──
        else if (topic.includes('/A2/analytics/cooler_condition') || topic.includes('/A2/condition/cooler_condition_pct')) {
            let state, txt, cls;
            if (v === 100)    { state = 'good';     txt = 'Optimal';   cls = 'healthy'; }
            else if (v >= 20) { state = 'warning';  txt = 'Degraded';  cls = 'warning'; }
            else              { state = 'critical'; txt = 'Failure';   cls = 'critical'; }

            document.getElementById('a2-cooler').textContent = txt + ' (' + v + '%)';
            document.getElementById('a2-cooler').className = 'gauge-value ' + state;
            document.getElementById('a2-bar').style.width = v + '%';
            setChip('a2-chip', cls.charAt(0).toUpperCase() + cls.slice(1), cls);
            setCardGlow('card-a2', 'asset-card ' + cls + '-glow');
            setAssetGlow('A2', COLORS[state]);
            _logEvent(`A2 — Cooler condition: ${txt} (${v}%)`, state === 'good' ? 'info' : state);
            // ── Viz ring buffer push ──
            _vizPush(vizData.A2.cooler,     Number(v) || 0);
            _vizPush(vizData.A2.timestamps, _vizTimestamp());
        }
        else if (topic.includes('/A2/analytics/valve_condition') || topic.includes('/A2/condition/valve_condition_pct')) {
            let state = 'good';
            if (v < 90) state = 'warning';
            if (v < 80) state = 'critical';
            document.getElementById('a2-valve').textContent = v + '%';
            document.getElementById('a2-valve').className = 'gauge-value mono ' + state;
            _logEvent(`A2 — Valve health: ${v}%`, state === 'good' ? 'info' : state);
            // ── Viz ring buffer push ──
            _vizPush(vizData.A2.valve, Number(v) || 0);
        }

        // ── A3 APU Compressor ──
        else if (topic.includes('/A3/analytics/anomaly')) {
            const score = payload.score ? payload.score.toFixed(3) : '—';
            document.getElementById('a3-score').textContent = score;
            document.getElementById('a3-bar').style.width = Math.min((payload.score || 0) * 100, 100) + '%';

            if (v === 1) {
                document.getElementById('a3-status').textContent = 'ANOMALY';
                document.getElementById('a3-status').className = 'gauge-value critical';
                document.getElementById('a3-score').className = 'gauge-value mono critical';
                setChip('a3-chip', 'Anomaly', 'critical');
                setCardGlow('card-a3', 'asset-card critical-glow');
                setAssetGlow('A3', COLORS.critical);
                a3Vibration = 0.4;
                document.getElementById('a3-bar').style.background = 'linear-gradient(90deg, #ff1744, #ff5252)';
                _logEvent(`A3 — ANOMALY detected (score: ${score})`, 'critical');
            } else {
                document.getElementById('a3-status').textContent = 'NORMAL';
                document.getElementById('a3-status').className = 'gauge-value good';
                document.getElementById('a3-score').className = 'gauge-value mono';
                setChip('a3-chip', 'Normal', 'healthy');
                setCardGlow('card-a3', 'asset-card healthy-glow');
                setAssetGlow('A3', COLORS.good);
                a3Vibration = 0;
                document.getElementById('a3-bar').style.background = 'linear-gradient(90deg, var(--a3-color), #a78bfa)';
            }
            // ── Viz ring buffer push ──
            _vizPush(vizData.A3.anomalyScore, payload.score != null ? +payload.score : 0);
            _vizPush(vizData.A3.timestamps,   _vizTimestamp());
        }

        // Live-refresh visualisation page on every message
        if (currentPage === 'visualisation') _vizRefreshCharts();

        // Live-refresh analytics KPI strip on every message
        if (currentPage === 'analytics') {
            const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            if (vizData.A1.failureProb.length)   setEl('an-kpi-a1',  vizData.A1.failureProb.at(-1).toFixed(1) + '%');
            if (vizData.A2.cooler.length)         setEl('an-kpi-a2c', vizData.A2.cooler.at(-1).toFixed(0)      + '%');
            if (vizData.A2.valve.length)          setEl('an-kpi-a2v', vizData.A2.valve.at(-1).toFixed(0)       + '%');
            if (vizData.A3.anomalyScore.length)   setEl('an-kpi-a3',  vizData.A3.anomalyScore.at(-1).toFixed(3));
        }

    } catch (e) {
        console.error('Parse error:', e);
    }
}

// =====================================================================
//  CLICK TO FOCUS (orbit to clicked asset)
// =====================================================================
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

renderer.domElement.addEventListener('click', (e) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    for (const [id, asset] of Object.entries(assets)) {
        if (!asset.group) continue;
        const hits = raycaster.intersectObjects(asset.group.children, true);
        if (hits.length > 0) {
            controls.autoRotate = false;
            const pos = asset.group.position;

            // Highlight corresponding card
            document.querySelectorAll('.asset-card').forEach(c => c.style.outline = 'none');
            const card = document.getElementById('card-' + id.toLowerCase());
            card.style.outline = '1px solid rgba(0,229,255,0.4)';
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            // Open detail panel first — this calls raisePanelScene() which shifts pos.y by +PANEL_LIFT
            openAssetDetail(id);

            // Point camera at the raised asset position
            const raisedY = pos.y; // pos.y already updated by raisePanelScene
            controls.target.set(pos.x, raisedY , pos.z);
            camera.position.set(pos.x + 8, raisedY + 5, pos.z + 30);

            setTimeout(() => { controls.autoRotate = true; }, 8000);
            break;
        }
    }
});

// Card click → focus 3D asset
document.querySelectorAll('.asset-card').forEach(card => {
    card.addEventListener('click', () => {
        const id = card.dataset.asset;
        if (!assets[id] || !assets[id].group) return;
        controls.autoRotate = false;
        const pos = assets[id].group.position;

        // Open detail panel first — this calls raisePanelScene() which shifts pos.y by +PANEL_LIFT
        openAssetDetail(id);

        // Point camera at the raised asset position
        const raisedY = pos.y; // pos.y already updated by raisePanelScene
        controls.target.set(pos.x, raisedY , pos.z);
        camera.position.set(pos.x + 8, raisedY + 5, pos.z + 30);
        
        setTimeout(() => { controls.autoRotate = true; }, 8000);
    });
});

document.getElementById('reset-view').addEventListener('click', resetCamera);
document.getElementById('reconnect-mqtt').addEventListener('click', () => {
    mqttBadge.className = 'conn-badge';
    mqttText.textContent = 'Reconnecting';
    try {
        client.disconnect();
    } catch (_) {
        // Best-effort disconnect before rebuilding the socket client.
    }
    buildClient();
    connectClient();
});

// Initialize navigation
initNavigation();

// Initialize asset detail panel handlers
document.getElementById('close-detail-panel').addEventListener('click', closeAssetDetail);
document.getElementById('asset-detail-overlay').addEventListener('click', closeAssetDetail);
