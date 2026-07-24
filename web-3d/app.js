

// =====================================================================
//  GLOBAL STATE
// =====================================================================
let currentPage = 'live-twin';
let sidebarOpen = false;
let assetStates = {
    A1: { status: 'initializing', lastSeen: 0 },
    A2: { status: 'initializing', lastSeen: 0 },
    A3: { status: 'initializing', lastSeen: 0 }
};
let activityLog = [];
let anomalyHistory = { A1: [], A2: [], A3: [] };
let messageCount = 0;
const startTime = Date.now();

// =====================================================================
//  THREE.JS SCENE SETUP (LIVE TWIN ONLY)
// =====================================================================
let scene, camera, renderer, controls, composer;
const assets = {
    A1: { group: null, glowParts: [], statusColor: 0x3b82f6 },
    A2: { group: null, glowParts: [], statusColor: 0x00f0ff },
    A3: { group: null, glowParts: [], statusColor: 0x7b61ff },
};

function initThreeJS() {
    const container = document.getElementById('canvas-container');
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0e1a);
    scene.fog = new THREE.FogExp2(0x0a0e1a, 0.008);

    camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 500);
    camera.position.set(0, 22, 45);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const keyLight = new THREE.DirectionalLight(0xdde4ff, 2.5);
    keyLight.position.set(25, 35, 20);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x4488ff, 0.8);
    fillLight.position.set(-15, 10, -10);
    scene.add(fillLight);
    const rimLight = new THREE.PointLight(0x00f0ff, 4, 60);
    rimLight.position.set(-20, 8, 15);
    scene.add(rimLight);
    const rimLight2 = new THREE.PointLight(0x7b61ff, 3, 50);
    rimLight2.position.set(20, 6, -10);
    scene.add(rimLight2);

    // Ground
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x0a0e1a, roughness: 0.85, metalness: 0.1 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Grid
    const grid = new THREE.GridHelper(120, 60, 0x00f0ff, 0x0a1530);
    grid.position.y = 0.02;
    grid.material.opacity = 0.12;
    grid.material.transparent = true;
    scene.add(grid);

    // Build assets
    buildA1();
    buildA2();
    buildA3();

    // Resize listener
    window.addEventListener('resize', onWindowResize);

    // Click to focus
    setupClickHandlers();
}

// Material library
const MAT = {
    body: () => new THREE.MeshStandardMaterial({ color: 0x3a4055, metalness: 0.7, roughness: 0.35 }),
    panel: () => new THREE.MeshStandardMaterial({ color: 0x2a2e3e, metalness: 0.3, roughness: 0.6 }),
    dark: () => new THREE.MeshStandardMaterial({ color: 0x1a1e2a, metalness: 0.5, roughness: 0.5 }),
    accent: (c) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.2, roughness: 0.3 }),
    glow: (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.9, metalness: 0.1, roughness: 0.2 }),
    glass: () => new THREE.MeshStandardMaterial({ color: 0x1a3050, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.4 }),
    chrome: () => new THREE.MeshStandardMaterial({ color: 0x888899, metalness: 0.95, roughness: 0.08 }),
    rubber: () => new THREE.MeshStandardMaterial({ color: 0x151515, metalness: 0.0, roughness: 0.95 }),
    pipe: (c) => new THREE.MeshStandardMaterial({ color: c || 0x556677, metalness: 0.6, roughness: 0.3 }),
};

function buildA1() {
    const g = new THREE.Group();
    const enclosure = new THREE.Mesh(new THREE.BoxGeometry(6, 5.5, 5), MAT.body());
    enclosure.position.set(0, 2.75, 0);
    enclosure.castShadow = true;
    enclosure.receiveShadow = true;
    g.add(enclosure);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3, 0.1), MAT.glass());
    glass.position.set(0, 3.2, 2.51);
    g.add(glass);
    const spindleHousing = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1.8, 2.5), MAT.panel());
    spindleHousing.position.set(0, 6.4, 0);
    spindleHousing.castShadow = true;
    g.add(spindleHousing);
    const bed = new THREE.Mesh(new THREE.BoxGeometry(7, 0.4, 6), MAT.dark());
    bed.position.set(0, 0.2, 0);
    bed.receiveShadow = true;
    g.add(bed);
    const glowMat = MAT.glow(assets.A1.statusColor);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.06, 16, 80), glowMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    g.add(ring);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.02, 8, 80), MAT.glow(assets.A1.statusColor));
    ring2.rotation.x = -Math.PI / 2;
    ring2.position.y = 0.6;
    g.add(ring2);
    assets.A1.group = g;
    assets.A1.glowParts = [glowMat, ring2.material];
    g.position.set(-18, 0, 0);
    scene.add(g);
}

function buildA2() {
    const g = new THREE.Group();
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 5, 32), MAT.body());
    tank.position.set(0, 2.8, 0);
    tank.castShadow = true;
    tank.receiveShadow = true;
    g.add(tank);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(8, 0.3, 8), MAT.dark());
    frame.position.set(0, 0.15, 0);
    frame.receiveShadow = true;
    g.add(frame);
    const glowMat = MAT.glow(assets.A2.statusColor);
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(5, 0.06, 16, 80), glowMat);
    r1.rotation.x = -Math.PI / 2;
    r1.position.y = 0.05;
    g.add(r1);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(5, 0.02, 8, 80), MAT.glow(assets.A2.statusColor));
    r2.rotation.x = -Math.PI / 2;
    r2.position.y = 0.5;
    g.add(r2);
    assets.A2.group = g;
    assets.A2.glowParts = [glowMat, r2.material];
    g.position.set(0, 0, 0);
    scene.add(g);
}

function buildA3() {
    const g = new THREE.Group();
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.0, 7, 32), MAT.body());
    housing.rotation.z = Math.PI / 2;
    housing.position.set(0, 2.5, 0);
    housing.castShadow = true;
    housing.receiveShadow = true;
    g.add(housing);
    const baseFrame = new THREE.Mesh(new THREE.BoxGeometry(10, 0.3, 7), MAT.dark());
    baseFrame.position.set(0, 0.15, 0);
    baseFrame.receiveShadow = true;
    g.add(baseFrame);
    const glowMat = MAT.glow(assets.A3.statusColor);
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(5.5, 0.06, 16, 80), glowMat);
    r1.rotation.x = -Math.PI / 2;
    r1.position.y = 0.05;
    g.add(r1);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(5.5, 0.02, 8, 80), MAT.glow(assets.A3.statusColor));
    r2.rotation.x = -Math.PI / 2;
    r2.position.y = 0.5;
    g.add(r2);
    assets.A3.group = g;
    assets.A3.glowParts = [glowMat, r2.material];
    g.position.set(20, 0, 0);
    scene.add(g);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function setupClickHandlers() {
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    renderer.domElement.addEventListener('click', (e) => {
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        for (const [id, asset] of Object.entries(assets)) {
            if (!asset.group) continue;
            const hits = raycaster.intersectObjects(asset.group.children, true);
            if (hits.length > 0) focusOnAsset(id);
        }
    });
    document.querySelectorAll('.asset-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.dataset.asset;
            if (id) focusOnAsset(id);
        });
    });
    document.getElementById('reset-view').addEventListener('click', resetCamera);
}

function focusOnAsset(id) {
    if (!assets[id] || !assets[id].group) return;
    const pos = assets[id].group.position;
    camera.position.set(pos.x + 8, 12, pos.z + 15);
}

function resetCamera() {
    camera.position.set(0, 22, 45);
    camera.lookAt(0, 4, 0);
}

const clock = new THREE.Clock();
function animate() {
    requestAnimationFrame(animate);
    if (currentPage === 'live-twin') {
        const t = clock.getElapsedTime();
        const pulse = Math.sin(t * 2.5) * 0.15 + 0.85;
        for (const id of ['A1', 'A2', 'A3']) {
            assets[id].glowParts.forEach(m => m.emissiveIntensity = pulse);
        }
        renderer.render(scene, camera);
    }
}

// =====================================================================
//  SIDEBAR & NAVIGATION
// =====================================================================
function initNavigation() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const sidebar = document.getElementById('sidebar');
    const sidebarItems = document.querySelectorAll('.sidebar-item');

    hamburgerBtn.addEventListener('click', toggleSidebar);
    sidebarOverlay.addEventListener('click', closeSidebar);
    
    sidebarItems.forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;
            navigateToPage(page);
            closeSidebar();
        });
    });
}

function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    updateSidebarUI();
}

function closeSidebar() {
    sidebarOpen = false;
    updateSidebarUI();
}

function updateSidebarUI() {
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    if (sidebarOpen) {
        sidebar.classList.add('active');
        sidebarOverlay.classList.add('active');
    } else {
        sidebar.classList.remove('active');
        sidebarOverlay.classList.remove('active');
    }
}

function navigateToPage(page) {
    currentPage = page;
    document.body.classList.remove('page-overview-active', 'page-analytics-active', 'page-documentation-active');
    if (page === 'overview') document.body.classList.add('page-overview-active');
    if (page === 'analytics') document.body.classList.add('page-analytics-active');
    if (page === 'documentation') document.body.classList.add('page-documentation-active');
    
    // Update sidebar active state
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === page) item.classList.add('active');
    });

    // Render page content
    if (page === 'overview') renderOverviewPage();
    if (page === 'analytics') renderAnalyticsPage();
    if (page === 'documentation') renderDocumentationPage();
}

// =====================================================================
//  OVERVIEW PAGE
// =====================================================================
function renderOverviewPage() {
    const container = document.getElementById('page-overview');
    container.innerHTML = `
        <div class="overview-grid">
            <div class="kpi-card">
                <div class="kpi-card-title">Overall Equipment Effectiveness</div>
                <div class="kpi-card-value">89%</div>
                <div class="kpi-card-sub">Target: ≥ 90%</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-title">Total Uptime</div>
                <div class="kpi-card-value">${Math.floor((Date.now() - startTime) / 3600000)}h</div>
                <div class="kpi-card-sub">Since last restart</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-title">Active Alerts</div>
                <div class="kpi-card-value">1</div>
                <div class="kpi-card-sub">2 Warnings, 0 Critical</div>
            </div>
        </div>

        <div class="overview-section">
            <div class="section-header">Asset Status</div>
            <div class="asset-grid">
                <div class="asset-grid-card" onclick="focusOnAssetFromOverview('A1')">
                    <div class="asset-grid-header">
                        <div>
                            <div class="asset-grid-name">A1 - CNC Milling</div>
                            <div class="asset-grid-type">Supervised Classification</div>
                        </div>
                        <div class="status-chip healthy">Healthy</div>
                    </div>
                </div>
                <div class="asset-grid-card" onclick="focusOnAssetFromOverview('A2')">
                    <div class="asset-grid-header">
                        <div>
                            <div class="asset-grid-name">A2 - Hydraulic System</div>
                            <div class="asset-grid-type">Multi-target Classification</div>
                        </div>
                        <div class="status-chip warning">Warning</div>
                    </div>
                </div>
                <div class="asset-grid-card" onclick="focusOnAssetFromOverview('A3')">
                    <div class="asset-grid-header">
                        <div>
                            <div class="asset-grid-name">A3 - APU Compressor</div>
                            <div class="asset-grid-type">Unsupervised Anomaly Detection</div>
                        </div>
                        <div class="status-chip ${assetStates.A3.status}">${assetStates.A3.status.charAt(0).toUpperCase() + assetStates.A3.status.slice(1)}</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="overview-section">
            <div class="section-header">Recent Activity</div>
            <div class="activity-log">
                ${activityLog.map(item => `
                    <div class="activity-item ${item.severity}">
                        <span class="activity-text">${item.text}</span>
                        <span class="activity-time">${item.time}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

window.focusOnAssetFromOverview = function(id) {
    navigateToPage('live-twin');
    setTimeout(() => focusOnAsset(id), 100);
}

// =====================================================================
//  ANALYTICS PAGE
// =====================================================================
function renderAnalyticsPage() {
    const container = document.getElementById('page-analytics');
    container.innerHTML = `
        <div class="overview-section">
            <div class="section-header">Model Registry</div>
            <div class="analytics-card">
                <table class="model-table">
                    <thead>
                        <tr>
                            <th>Model Name</th>
                            <th>Asset</th>
                            <th>Type</th>
                            <th>Version</th>
                            <th>Last Trained</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>CNC Failure Predictor</td>
                            <td>A1</td>
                            <td>Classification</td>
                            <td>v1.2.0</td>
                            <td>2024-07-20</td>
                            <td><span class="status-chip healthy">Active</span></td>
                        </tr>
                        <tr>
                            <td>Hydraulic Condition Estimator</td>
                            <td>A2</td>
                            <td>Multi-target</td>
                            <td>v2.0.1</td>
                            <td>2024-07-22</td>
                            <td><span class="status-chip healthy">Active</span></td>
                        </tr>
                        <tr>
                            <td>APU Anomaly Detector</td>
                            <td>A3</td>
                            <td>Anomaly Detection</td>
                            <td>v3.1.0</td>
                            <td>2024-07-23</td>
                            <td><span class="status-chip healthy">Active</span></td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <div class="analytics-grid">
            <div class="analytics-card">
                <div class="section-header">Model Metrics</div>
                <div style="padding: 16px 0;">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;">
                        <div style="text-align: center; padding: 16px; background: rgba(0,240,255,0.05); border-radius: 8px;">
                            <div style="font-size: 2rem; font-weight: 700; color: #00f0ff; font-family: 'JetBrains Mono', monospace;">98.5%</div>
                            <div style="font-size: 0.75rem; color: #6b8a9a; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px;">Accuracy</div>
                        </div>
                        <div style="text-align: center; padding: 16px; background: rgba(0,240,255,0.05); border-radius: 8px;">
                            <div style="font-size: 2rem; font-weight: 700; color: #00f0ff; font-family: 'JetBrains Mono', monospace;">0.97</div>
                            <div style="font-size: 0.75rem; color: #6b8a9a; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px;">F1 Score</div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="analytics-card">
                <div class="section-header">Anomaly Score Distribution</div>
                <div id="anomaly-chart" style="width: 100%; height: 250px;"></div>
            </div>
        </div>
    `;
}

// =====================================================================
//  DOCUMENTATION PAGE
// =====================================================================
const docSections = [
    { id: 'architecture', title: 'System Architecture', content: `
# System Architecture

The JESA Digital Twin system consists of three main layers:

1. **Data Acquisition Layer**: Simulators and PLC for generating telemetry
2. **Processing Layer**: UNS gateway and ML inference service
3. **Presentation Layer**: 3D digital twin and Grafana dashboards

## Data Flow
Simulators → PLC → UNS Gateway → MQTT Broker → (UI + Telegraf) → InfluxDB → Grafana
    `},
    { id: 'sensors', title: 'Sensor & Asset Reference', content: `
# Sensor & Asset Reference

## A1 - CNC Milling Machine
- Tool wear sensor
- Vibration accelerometer
- Spindle motor current
- Temperature sensors

## A2 - Hydraulic System
- Cooler condition
- Valve state
- Internal pump leakage
- Hydraulic accumulator pressure

## A3 - APU Compressor
- Pressure sensors (TP2, TP3)
- Temperature readings
- Motor current
    `},
    { id: 'mqtt', title: 'MQTT Topic Schema', content: `
# MQTT Topic Schema

## Base Topic
\`jesa/site1/\`

## Sub-topics
- \`workshop/milling/A1/<sensor>\`: A1 telemetry
- \`workshop/hydraulics/A2/<sensor>\`: A2 telemetry
- \`fleet/apu/A3/<sensor>\`: A3 telemetry
- \`analytics/<asset>/status\`: ML predictions
    `},
    { id: 'thresholds', title: 'Alert Thresholds & Definitions', content: `
# Alert Thresholds & Definitions

## Status Levels
- **Healthy**: System operating within normal parameters
- **Warning**: Attention required soon
- **Critical**: Immediate action required

## Thresholds
- A1 Failure Probability > 0.7 → Warning
- A1 Failure Probability > 0.9 → Critical
- A2 Cooler Condition < 20% → Critical
- A3 Anomaly Score > 0.7 → Warning
- A3 Anomaly Score > 0.85 → Critical
    `},
    { id: 'troubleshooting', title: 'Troubleshooting', content: `
# Troubleshooting

## Asset shows "Stale" status
1. Verify simulator is running
2. Check MQTT broker connection
3. Check UNS gateway is connected

## No data in Grafana
1. Verify Telegraf is running
2. Check InfluxDB connection
3. Verify MQTT topics are being published
    `}
];
let currentDocSection = 'architecture';
let docSearchQuery = '';

function renderDocumentationPage() {
    const container = document.getElementById('page-documentation');
    const filteredSections = docSections.filter(s => 
        s.title.toLowerCase().includes(docSearchQuery.toLowerCase()) ||
        s.content.toLowerCase().includes(docSearchQuery.toLowerCase())
    );

    container.innerHTML = `
        <div class="doc-container">
            <div class="doc-toc">
                <h3>Table of Contents</h3>
                <ul>
                    ${filteredSections.map(s => `
                        <li class="${s.id === currentDocSection ? 'active' : ''}" 
                            onclick="setDocSection('${s.id}')">${s.title}</li>
                    `).join('')}
                </ul>
            </div>
            <div class="doc-content">
                <input type="text" class="doc-search" placeholder="Search documentation..." 
                    value="${docSearchQuery}" 
                    oninput="updateDocSearch(this.value)">
                <div class="doc-markdown" id="doc-markdown-content"></div>
            </div>
        </div>
    `;
    renderDocMarkdown();
}

window.setDocSection = function(id) {
    currentDocSection = id;
    renderDocumentationPage();
};

window.updateDocSearch = function(query) {
    docSearchQuery = query;
    renderDocumentationPage();
};

function renderDocMarkdown() {
    const section = docSections.find(s => s.id === currentDocSection);
    if (section && window.marked) {
        document.getElementById('doc-markdown-content').innerHTML = marked.parse(section.content);
    }
}

// =====================================================================
//  MQTT CONNECTION & DATA HANDLING
// =====================================================================
let mqttClient = null;

function initMQTT() {
    const mqttBadge = document.getElementById('mqtt-status');
    const mqttText = mqttBadge.querySelector('.conn-text');
    
    mqttClient = new Paho.Client("127.0.0.1", 9001, "/", "jesa_twin_" + Math.random().toString(36).substring(2, 9));
    mqttClient.onConnectionLost = onConnectionLost;
    mqttClient.onMessageArrived = onMessageArrived;
    
    mqttClient.connect({
        onSuccess: onConnect,
        onFailure: onFailure,
        reconnect: true,
        keepAliveInterval: 30,
    });

    document.getElementById('reconnect-mqtt').addEventListener('click', () => {
        mqttBadge.className = 'conn-badge';
        mqttText.textContent = 'Reconnecting';
        try { mqttClient.disconnect(); } catch (_) {}
        initMQTT();
    });
}

function onConnect() {
    console.log('%c✓ MQTT Connected', 'color:#10b981;font-weight:bold');
    const mqttBadge = document.getElementById('mqtt-status');
    const mqttText = mqttBadge.querySelector('.conn-text');
    mqttBadge.className = 'conn-badge live';
    mqttText.textContent = 'Live';
    mqttClient.subscribe('jesa/site1/workshop/milling/A1/#');
    mqttClient.subscribe('jesa/site1/workshop/hydraulics/A2/#');
    mqttClient.subscribe('jesa/site1/fleet/apu/A3/#');
}

function onFailure(err) {
    console.error('MQTT failed:', err.errorMessage);
    const mqttBadge = document.getElementById('mqtt-status');
    const mqttText = mqttBadge.querySelector('.conn-text');
    mqttBadge.className = 'conn-badge offline';
    mqttText.textContent = 'Offline';
}

function onConnectionLost(resp) {
    if (resp.errorCode !== 0) {
        console.warn('MQTT lost:', resp.errorMessage);
        const mqttBadge = document.getElementById('mqtt-status');
        const mqttText = mqttBadge.querySelector('.conn-text');
        mqttBadge.className = 'conn-badge offline';
        mqttText.textContent = 'Offline';
    }
}

const assetTelemetry = {
    A1: { lastSeen: 0, updates: 0 },
    A2: { lastSeen: 0, updates: 0 },
    A3: { lastSeen: 0, updates: 0 },
};
const STALE_MS = { A1: 8000, A2: 70000, A3: 20000 };

function onMessageArrived(message) {
    messageCount++;
    document.getElementById('msg-count').textContent = messageCount.toLocaleString();

    try {
        const payload = JSON.parse(message.payloadString);
        const topic = message.destinationName;

        if (topic.includes('/A1/')) {
            assetTelemetry.A1.lastSeen = Date.now();
            assetTelemetry.A1.updates++;
            if (topic.includes('analytics/machine_failure') || topic.includes('status/machine_failure')) {
                const failureProbability = payload.probability ?? ((payload.v === 1 || payload.v === true) ? 1 : 0);
                const prob = (Number(failureProbability) * 100).toFixed(1);
                document.getElementById('a1-prob').textContent = prob + '%';
                document.getElementById('a1-bar').style.width = prob + '%';
                if (payload.v === 1 || payload.v === true) {
                    document.getElementById('a1-status').textContent = 'FAILURE';
                    document.getElementById('a1-status').className = 'gauge-value critical';
                    document.getElementById('a1-prob').className = 'gauge-value mono critical';
                    setChip('a1-chip', 'Critical', 'critical');
                    setCardGlow('card-a1', 'asset-card critical-glow');
                    setAssetGlow('A1', 0xef4444);
                    document.getElementById('a1-bar').style.background = 'linear-gradient(90deg, #ef4444, #ff5252)';
                    assetStates.A1.status = 'critical';
                } else {
                    document.getElementById('a1-status').textContent = 'HEALTHY';
                    document.getElementById('a1-status').className = 'gauge-value good';
                    document.getElementById('a1-prob').className = 'gauge-value mono';
                    setChip('a1-chip', 'Healthy', 'healthy');
                    setCardGlow('card-a1', 'asset-card healthy-glow');
                    setAssetGlow('A1', 0x10b981);
                    document.getElementById('a1-bar').style.background = 'linear-gradient(90deg, #3b82f6, #6c9bff)';
                    assetStates.A1.status = 'healthy';
                }
            }
        }

        if (topic.includes('/A2/')) {
            assetTelemetry.A2.lastSeen = Date.now();
            assetTelemetry.A2.updates++;
            if (topic.includes('analytics/cooler_condition') || topic.includes('condition/cooler_condition_pct')) {
                const v = payload.v;
                let state, txt, cls;
                if (v === 100) { state = 'good'; txt = 'Optimal'; cls = 'healthy'; }
                else if (v >= 20) { state = 'warning'; txt = 'Degraded'; cls = 'warning'; }
                else { state = 'critical'; txt = 'Failure'; cls = 'critical'; }
                document.getElementById('a2-cooler').textContent = txt + ' (' + v + '%)';
                document.getElementById('a2-cooler').className = 'gauge-value ' + state;
                document.getElementById('a2-bar').style.width = v + '%';
                setChip('a2-chip', cls.charAt(0).toUpperCase() + cls.slice(1), cls);
                setCardGlow('card-a2', 'asset-card ' + cls + '-glow');
                const colorMap = { good: 0x10b981, warning: 0xf59e0b, critical: 0xef4444 };
                setAssetGlow('A2', colorMap[state]);
                assetStates.A2.status = cls;
            } else if (topic.includes('analytics/valve_condition') || topic.includes('condition/valve_condition_pct')) {
                let state = 'good';
                if (payload.v < 90) state = 'warning';
                if (payload.v < 80) state = 'critical';
                document.getElementById('a2-valve').textContent = payload.v + '%';
                document.getElementById('a2-valve').className = 'gauge-value mono ' + state;
            }
        }

        if (topic.includes('/A3/')) {
            assetTelemetry.A3.lastSeen = Date.now();
            assetTelemetry.A3.updates++;
            if (topic.includes('analytics/anomaly')) {
                const score = payload.score ? payload.score.toFixed(3) : '—';
                document.getElementById('a3-score').textContent = score;
                document.getElementById('a3-bar').style.width = Math.min((payload.score || 0) * 100, 100) + '%';
                if (payload.v === 1) {
                    document.getElementById('a3-status').textContent = 'ANOMALY';
                    document.getElementById('a3-status').className = 'gauge-value critical';
                    document.getElementById('a3-score').className = 'gauge-value mono critical';
                    setChip('a3-chip', 'Anomaly', 'critical');
                    setCardGlow('card-a3', 'asset-card critical-glow');
                    setAssetGlow('A3', 0xef4444);
                    document.getElementById('a3-bar').style.background = 'linear-gradient(90deg, #ef4444, #ff5252)';
                    assetStates.A3.status = 'critical';
                } else {
                    document.getElementById('a3-status').textContent = 'NORMAL';
                    document.getElementById('a3-status').className = 'gauge-value good';
                    document.getElementById('a3-score').className = 'gauge-value mono';
                    setChip('a3-chip', 'Normal', 'healthy');
                    setCardGlow('card-a3', 'asset-card healthy-glow');
                    setAssetGlow('A3', 0x10b981);
                    document.getElementById('a3-bar').style.background = 'linear-gradient(90deg, #7b61ff, #a78bfa)';
                    assetStates.A3.status = 'healthy';
                }
            }
        }

        // Update last seen time
        const now = new Date();
        const timeStr = now.toLocaleTimeString();
        for (const id of ['A1', 'A2', 'A3']) {
            const el = document.getElementById(`${id.toLowerCase()}-last`);
            if (el) el.textContent = formatLastSeen(id);
        }
    } catch (e) {
        console.error('Parse error:', e);
    }
}

function setChip(id, text, cls) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = text;
        el.className = 'status-chip ' + cls;
    }
}

function setCardGlow(cardId, cls) {
    const el = document.getElementById(cardId);
    if (el) el.className = cls;
}

function setAssetGlow(assetId, colorHex) {
    if (assets[assetId]) {
        assets[assetId].glowParts.forEach(m => {
            m.color.setHex(colorHex);
            m.emissive.setHex(colorHex);
        });
    }
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
        if (age <= STALE_MS[assetId]) online++;
        else if (assetTelemetry[assetId].updates > 0 && assetStates[assetId].status !== 'critical') {
            setChip(`${assetId.toLowerCase()}-chip`, 'Stale', 'warning');
            setCardGlow(`card-${assetId.toLowerCase()}`, 'asset-card warning-glow');
        }
    }
    document.getElementById('assets-online').textContent = `${online}/3`;
}

function updateUptime() {
    const sec = Math.floor((Date.now() - startTime) / 1000);
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    document.getElementById('uptime').textContent = `${m}:${s}`;
}

// =====================================================================
//  INITIALIZATION
// =====================================================================
function initActivityLog() {
    activityLog = [
        { text: 'A3 anomaly detected: High vibration', severity: 'critical', time: '14:32:15' },
        { text: 'A2 cooler condition degraded', severity: 'warning', time: '14:28:42' },
        { text: 'System maintenance check completed', severity: 'healthy', time: '14:15:00' },
        { text: 'A1 tool wear increased', severity: 'warning', time: '13:58:22' },
        { text: 'All assets online', severity: 'healthy', time: '13:30:00' }
    ];
}

window.addEventListener('DOMContentLoaded', () => {
    initThreeJS();
    initNavigation();
    initMQTT();
    initActivityLog();
    setInterval(refreshTelemetryHealth, 2000);
    setInterval(updateUptime, 1000);
    animate();
    // Set initial active sidebar item
    document.querySelector('.sidebar-item[data-page="live-twin"]').classList.add('active');
});
