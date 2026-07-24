// --- SİMÜLASYON DURUMU ---
let state = {
    budget: 100000, emissions: 0, totalOpex: 0, incomePerMw: 5.0, 
    population: 1000, maxPopulation: 1000, demandPerPerson: 0.05,
    hour: 8, isDay: true, windEfficiency: 1.0, solarEfficiency: 0.4, 
    land: { cityUsed: 0, cityMax: 500, ruralUsed: 0, ruralMax: 9000, forestUsed: 0, forestMax: 1000 },
    expansions: { city: 0, rural: 0, forest: 0 }, // Yeni eklenen zemin sayısını tutar
    installed: {
        city: { coal:0, gas:0, geo:0, hydro:0, solar:0, wind:0, solarStorage:0, windStorage:0, tree:0, house: 20 },
        rural: { coal:0, gas:0, geo:0, hydro:0, solar:0, wind:0, solarStorage:0, windStorage:0, tree:0, house:0 },
        forest: { coal:0, gas:0, geo:0, hydro:0, solar:0, wind:0, solarStorage:0, windStorage:0, tree:0, house:0 }
    }
};

let currentPreviewType = 'solar'; 
let lastAdvisorState = null; // Danışman durumu değiştiğinde tekrar tekrar ses çalmamak için

// HEDEFLER (GÖREVLER) - 3 Günlük, 1 Genel
let dailyGoals = [];
let generalGoal = { type: 'pop', target: 2000, current: 1000, reward: 50000, desc: "Şehir nüfusunu 2000'e ulaştır" };

const plants = {
    gas:     { costPerMw: 1500, emissionPerMw: 0.8, opexPerMw: 2.0, landPerMw: 0.1, allowedInCity: false, name: "Doğalgaz", icon: "🔥", color: 0xe67e22, geometry: 'cylinder', modelPath: 'assets/models/power/gas.glb' },
    coal:    { costPerMw: 3000, emissionPerMw: 1.5, opexPerMw: 1.0, landPerMw: 0.2, allowedInCity: false, name: "Kömür", icon: "🏭", color: 0x34495e, geometry: 'box_tall', modelPath: 'assets/models/power/coal.glb' },
    geo:     { costPerMw: 5000, emissionPerMw: 0,   opexPerMw: 0.5, landPerMw: 0.5, allowedInCity: false, name: "Jeotermal", icon: "🌋", color: 0xe74c3c, geometry: 'cylinder_low', modelPath: 'assets/models/power/geo.glb' },
    hydro:   { costPerMw: 5000, emissionPerMw: 0,   opexPerMw: 0.1, landPerMw: 20.0,allowedInCity: false, name: "Hidrolik", icon: "🌊", color: 0x0984e3, geometry: 'box_wide', modelPath: 'assets/models/power/hydro.glb' },
    wind:    { costPerMw: 1800, emissionPerMw: 0,   opexPerMw: 0.3, landPerMw: 10.0,allowedInCity: false, name: "Rüzgar", icon: "🌬️", color: 0xffffff, geometry: 'turbine', modelPath: 'assets/models/power/wind.glb' },
    solar:   { costPerMw: 800,  emissionPerMw: 0,   opexPerMw: 0.1, landPerMw: 3.0, allowedInCity: true,  name: "Güneş", icon: "☀️", color: 0x111111, geometry: 'panel', modelPath: 'assets/models/power/solar.glb' },
    battery: { costPerMw: 1500, emissionPerMw: 0,   opexPerMw: 0.1, landPerMw: 0.1, allowedInCity: true,  name: "Depolama", icon: "🔋", color: 0x8e44ad, geometry: 'box', modelPath: 'assets/models/power/battery.glb' },
    tree:    { costPerMw: 100, emissionPerMw:-0.08, opexPerMw: 0.05,landPerMw: 1.0, allowedInCity: false, name: "Orman", icon: "🌳", color: 0x27ae60, geometry: 'cone', modelPath: 'assets/models/power/tree.glb' },
    house:   { costPerMw: 2000, emissionPerMw: 0.1, opexPerMw: 0.1, landPerMw: 5.0, allowedInCity: true,  name: "Yerleşim", icon: "🏠", color: 0xecf0f1, geometry: 'house', modelPath: 'assets/models/buildings/house.glb' }
};

// --- SES MOTORU (Harici dosya gerektirmez, tarayıcıda anlık üretilir) ---
window.SoundEngine = (function () {
    let ctx = null;
    let enabled = true;
    try {
        const saved = localStorage.getItem('ecogrid_sound_enabled');
        if (saved !== null) enabled = saved === '1';
    } catch (e) { /* localStorage yoksa sessizce devam et */ }

    function getCtx() {
        if (!enabled) return null;
        if (!ctx) {
            try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
            catch (e) { return null; }
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    function beep(freq, duration, type, volume, delay) {
        const c = getCtx();
        if (!c) return;
        delay = delay || 0;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = type || 'sine';
        osc.frequency.setValueAtTime(freq, c.currentTime + delay);
        gain.gain.setValueAtTime(0.0001, c.currentTime + delay);
        gain.gain.linearRampToValueAtTime(volume, c.currentTime + delay + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + delay + duration);
        osc.connect(gain); gain.connect(c.destination);
        osc.start(c.currentTime + delay);
        osc.stop(c.currentTime + delay + duration + 0.05);
    }

    return {
        build: function () { beep(520, 0.12, 'triangle', 0.18); beep(780, 0.14, 'triangle', 0.14, 0.08); },
        upgrade: function () { beep(440, 0.1, 'square', 0.15); beep(660, 0.12, 'square', 0.15, 0.08); beep(880, 0.16, 'square', 0.15, 0.16); },
        demolish: function () { beep(220, 0.2, 'sawtooth', 0.18); beep(120, 0.25, 'sawtooth', 0.16, 0.1); },
        land: function () { beep(350, 0.1, 'triangle', 0.15); beep(500, 0.14, 'triangle', 0.13, 0.09); },
        goal: function () { beep(660, 0.12, 'sine', 0.2); beep(880, 0.12, 'sine', 0.2, 0.1); beep(1100, 0.22, 'sine', 0.22, 0.2); },
        error: function () { beep(160, 0.18, 'sawtooth', 0.16); beep(110, 0.22, 'sawtooth', 0.14, 0.12); },
        click: function () { beep(300, 0.05, 'sine', 0.07); },
        stateGood: function () { beep(523, 0.15, 'sine', 0.13); beep(659, 0.15, 'sine', 0.13, 0.1); beep(784, 0.25, 'sine', 0.15, 0.2); },
        stateAlarm: function () { beep(880, 0.15, 'square', 0.16); beep(660, 0.15, 'square', 0.16, 0.18); beep(880, 0.15, 'square', 0.16, 0.36); },
        toggle: function () {
            enabled = !enabled;
            try { localStorage.setItem('ecogrid_sound_enabled', enabled ? '1' : '0'); } catch (e) {}
            if (enabled) { getCtx(); beep(440, 0.08, 'sine', 0.1); }
            return enabled;
        },
        isEnabled: function () { return enabled; }
    };
})();

// --- THREE.JS KURULUMU ---
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#ecf0f1'); 
scene.fog = new THREE.FogExp2(0x7f8c8d, 0.0);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
scene.add(ambientLight);
const hemiLight = new THREE.HemisphereLight(0xbfd8ff, 0x4a3728, 0.55);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xfff3e0, 0.9);
dirLight.position.set(20, 30, 10);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.left = -30;
dirLight.shadow.camera.right = 30;
dirLight.shadow.camera.top = 30;
dirLight.shadow.camera.bottom = -30;
dirLight.shadow.bias = -0.001;
scene.add(dirLight);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(0, 15, 20); 

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.05; 

// SADECE GÖRÜNMEZ ÇİZGİLER (Artık devasa planlar yok, zeminleri kare kare kendimiz çizeceğiz)
window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});

let gridMap = []; // Her bir zemin karesini {row, col, zone, isOccupied} olarak tutar
let meshes = []; 
let gltfLoader = null;
if (typeof THREE.GLTFLoader !== 'undefined') { gltfLoader = new THREE.GLTFLoader(); }

// --- PROSEDÜREL ZEMİN DOKULARI (dış dosya gerekmeden gerçekçi görünüm) ---
function shadeRgb(hex, amt) {
    let num = parseInt(hex.replace('#', ''), 16);
    let r = Math.min(255, Math.max(0, (num >> 16) + amt));
    let g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amt));
    let b = Math.min(255, Math.max(0, (num & 0xff) + amt));
    return `rgb(${r},${g},${b})`;
}
function makeZoneTexture(baseHex, style) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const tctx = c.getContext('2d');
    tctx.fillStyle = baseHex;
    tctx.fillRect(0, 0, 128, 128);

    if (style === 'city') {
        // Beton fayans deseni: ince çizgiler + hafif leke
        tctx.strokeStyle = shadeRgb(baseHex, -18);
        tctx.lineWidth = 2;
        for (let i = 0; i <= 128; i += 32) {
            tctx.beginPath(); tctx.moveTo(i, 0); tctx.lineTo(i, 128); tctx.stroke();
            tctx.beginPath(); tctx.moveTo(0, i); tctx.lineTo(128, i); tctx.stroke();
        }
        for (let i = 0; i < 90; i++) {
            tctx.fillStyle = shadeRgb(baseHex, (Math.random() * 20 - 10));
            tctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
        }
    } else if (style === 'forest') {
        // Çim: yoğun küçük yeşil benekler
        for (let i = 0; i < 500; i++) {
            tctx.fillStyle = shadeRgb(baseHex, Math.random() * 50 - 25);
            const x = Math.random() * 128, y = Math.random() * 128;
            tctx.fillRect(x, y, 1.5, Math.random() * 4 + 2);
        }
    } else {
        // Toprak/kırsal: düzensiz leke ve çakıl benekleri
        for (let i = 0; i < 260; i++) {
            tctx.fillStyle = shadeRgb(baseHex, Math.random() * 40 - 20);
            const x = Math.random() * 128, y = Math.random() * 128;
            const s = Math.random() * 3 + 1;
            tctx.beginPath(); tctx.arc(x, y, s, 0, Math.PI * 2); tctx.fill();
        }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    return tex;
}

const zoneStyle = { city: { hex: '#dcdde1', style: 'city' }, rural: { hex: '#a06540', style: 'rural' }, forest: { hex: '#5fc97a', style: 'forest' } };
const zoneMaterials = {};
Object.keys(zoneStyle).forEach(z => {
    zoneMaterials[z] = new THREE.MeshStandardMaterial({
        map: makeZoneTexture(zoneStyle[z].hex, zoneStyle[z].style),
        roughness: z === 'city' ? 0.75 : 0.95,
        depthWrite: false
    });
});
const tileEdgeGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.95, 0.95));
const tileEdgeMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12 });

// --- DİNAMİK ZEMİN FAYANSLARI ÇİZİCİ ---
function createGroundTile(row, col, zone) {
    let tileGeo = new THREE.PlaneGeometry(0.95, 0.95); // 0.95 yaparak aralarında ızgara boşluğu bırakıyoruz
    let tileMesh = new THREE.Mesh(tileGeo, zoneMaterials[zone]);
    tileMesh.rotation.x = -Math.PI / 2;
    tileMesh.position.set(col - 9.5, 0, row - 9.5);
    tileMesh.receiveShadow = true;

    // Belirgin ızgara çizgisi: her karenin kenarına ince, hafif saydam bir çerçeve
    let edges = new THREE.LineSegments(tileEdgeGeo, tileEdgeMat);
    edges.position.z = 0.002; // z-fighting önlemek için hafif yukarı (yerel eksende, döndürme sonrası yukarı karşılık gelir)
    tileMesh.add(edges);

    scene.add(tileMesh);
    
    // Grid veritabanına kaydet
    gridMap.push({ row: row, col: col, zone: zone, isOccupied: false, visualMesh: tileMesh });
}

// Oyuna başlarken orijinal kapasiteleri kare kare çizelim
function initializeGround() {
    // City: 40 kare (Cols 0-1, Rows 0-19)
    for (let r = 0; r < 20; r++) { for (let c = 0; c < 2; c++) createGroundTile(r, c, 'city'); }
    // Rural: 320 kare (Cols 2-17, Rows 0-19)
    for (let r = 0; r < 20; r++) { for (let c = 2; c < 18; c++) createGroundTile(r, c, 'rural'); }
    // Forest: 40 kare (Cols 18-19, Rows 0-19)
    for (let r = 0; r < 20; r++) { for (let c = 18; c < 20; c++) createGroundTile(r, c, 'forest'); }
}
initializeGround();

// --- BAŞLANGIÇ ŞEHRİ (EVLERİ YERLEŞTİR) ---
function generateInitialCity() {
    // Şehir karelerini bul
    let citySlots = gridMap.filter(t => t.zone === 'city');
    
    for (let i = 0; i < 20; i++) { // 20 ev
        let randomTile = citySlots[Math.floor(Math.random() * citySlots.length)];
        while(randomTile.isOccupied) { // Boş kare bulana kadar
            randomTile = citySlots[Math.floor(Math.random() * citySlots.length)];
        }
        
        randomTile.isOccupied = true; 
        let houseGroup = createFallbackMesh('house', 0xecf0f1);
        houseGroup.position.set(randomTile.col - 9.5, 0, randomTile.row - 9.5);
        houseGroup.userData = { type: 'house', name: "Yerleşim", icon: "🏠", zone: 'city', capacity: 1, ems: 0.1, opex: 0.1, land: 5, gridRef: randomTile };
        
        scene.add(houseGroup);
        meshes.push(houseGroup);
    }
    state.land.cityUsed += 100; // 20 ev x 5 ha
}
generateInitialCity();

// --- ARAZİ SATIN ALMA (HARİTAYA ZEMİN EKLER) ---
window.buyLand = function() {
    let type = document.getElementById('landBuySelect').value;
    let cost = type === 'city' ? 20000 : (type === 'rural' ? 10000 : 5000);
    
    if (state.budget < cost) { SoundEngine.error(); alert("Bu araziyi satın almak için yeterli bütçen yok!"); return; }
    
    SoundEngine.land();
    state.budget -= cost;
    state.land[type + 'Max'] += 50; // Her satın alım 50ha = 4 kare
    
    // ZEMİNE FİZİKSEL OLARAK 4 KARE EKLİYORUZ
    for(let i=0; i<4; i++) {
        let e = state.expansions[type];
        let r = 0, c = 0;
        
        // Mantıklı bir şekilde aşağı doğru (Z ekseninde) genişleterek çiz
        if (type === 'city') { r = 20 + Math.floor(e / 2); c = e % 2; }
        else if (type === 'forest') { r = 20 + Math.floor(e / 2); c = 18 + (e % 2); }
        else if (type === 'rural') { r = 20 + Math.floor(e / 16); c = 2 + (e % 16); }
        
        createGroundTile(r, c, type);
        state.expansions[type]++;
    }
    
    let typeName = type === 'city' ? 'Şehir İçi' : (type === 'rural' ? 'Kırsal Alan' : 'Orman');
    alert(`Harika! ${typeName} haritada 50 ha genişledi. Uca eklenen yeni arazilere bakabilirsin!`);
    updateUI();
};

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

// --- 3D İNŞAAT SİSTEMİ ---
function getNextEmptySlot(zone) {
    return gridMap.find(t => t.zone === zone && !t.isOccupied);
}

function createMeshForPlant(type, colorCode, geometryType, modelPath, callback) {
    if (gltfLoader) {
        gltfLoader.load(modelPath, (gltf) => {
            let model = gltf.scene;
            model.scale.set(1.5, 1.5, 1.5); 
            model.traverse((child) => { if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; } });
            let box = new THREE.Box3().setFromObject(model);
            let center = box.getCenter(new THREE.Vector3());
            model.position.x += (model.position.x - center.x);
            model.position.z += (model.position.z - center.z);
            model.position.y += (model.position.y - box.min.y);
            callback(model);
        }, undefined, (error) => { callback(createFallbackMesh(geometryType, colorCode)); });
    } else { callback(createFallbackMesh(geometryType, colorCode)); }
}

function createFallbackMesh(geometryType, colorCode) {
    let group = new THREE.Group(); 
    let mainMat = new THREE.MeshStandardMaterial({ color: colorCode, roughness: 0.7 });
    let detailMat = new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.9 });

    if (geometryType === 'box_tall') {
        let base = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), mainMat); base.position.y = 0.25;
        let chim1 = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.8, 16), detailMat); chim1.position.set(-0.2, 0.6, -0.2);
        let chim2 = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.8, 16), detailMat); chim2.position.set(0.2, 0.6, -0.2);
        base.castShadow = true; chim1.castShadow = true; chim2.castShadow = true;
        group.add(base, chim1, chim2);
    } 
    else if (geometryType === 'house') {
        let base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.6), mainMat); base.position.y = 0.25;
        let roof = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.4, 4), new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.9 }));
        roof.position.y = 0.7; roof.rotation.y = Math.PI / 4;
        base.castShadow = true; roof.castShadow = true;
        group.add(base, roof);
    }
    else if (geometryType === 'cylinder') {
        let base = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.4, 16), mainMat); base.position.y = 0.2;
        let pipe = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.1), detailMat); pipe.position.set(0, 0.45, 0);
        base.castShadow = true; pipe.castShadow = true; group.add(base, pipe);
    }
    else if (geometryType === 'turbine') {
        let pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.2, 8), mainMat); pole.position.y = 0.6;
        let motor = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.2), mainMat); motor.position.set(0, 1.2, 0);
        let blade = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.8, 0.02), detailMat); blade.position.set(0, 1.2, 0.1);
        pole.castShadow = true; motor.castShadow = true; blade.castShadow = true;
        group.add(pole, motor, blade); group.userData.isWind = true; group.userData.blade = blade;
    }
    else if (geometryType === 'panel') {
        let panel = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.05, 0.8), mainMat); panel.rotation.x = Math.PI / 6; panel.position.y = 0.2;
        let stand = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.2), detailMat); stand.position.y = 0.1;
        panel.castShadow = true; stand.castShadow = true; group.add(stand, panel);
    }
    else if (geometryType === 'box_wide') {
        let dam = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.4), mainMat); dam.position.y = 0.3;
        let water = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.1, 0.4), new THREE.MeshStandardMaterial({color: 0x3498db})); water.position.set(0, 0.1, 0.4);
        dam.castShadow = true; water.receiveShadow = true; group.add(dam, water);
    }
    else if (geometryType === 'box') {
        let bat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.6), mainMat); bat.position.y = 0.2;
        let indicator = new THREE.Mesh(new THREE.BoxGeometry(0.51, 0.1, 0.1), new THREE.MeshStandardMaterial({color: 0x2ecc71})); indicator.position.set(0, 0.2, 0.26);
        bat.castShadow = true; group.add(bat, indicator);
    }
    else if (geometryType === 'cone') {
        let trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3), detailMat); trunk.position.y = 0.15;
        let leaves = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.6, 8), mainMat); leaves.position.y = 0.5;
        trunk.castShadow = true; leaves.castShadow = true; group.add(trunk, leaves);
    }
    else { 
        let geo = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.4, 16), mainMat); geo.position.y = 0.2; geo.castShadow = true; group.add(geo);
    }
    return group;
}

// --- ETKİLEŞİM VE GÖRSEL PANELLER ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tooltip = document.getElementById('tooltip3d');
const actionMenu = document.getElementById('actionMenu3d');
let selectedMesh = null; 

container.addEventListener('mousemove', (e) => {
    let rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ( (e.clientX - rect.left) / rect.width ) * 2 - 1;
    mouse.y = - ( (e.clientY - rect.top) / rect.height ) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    let intersects = raycaster.intersectObjects(meshes, true);
    
    if (intersects.length > 0) {
        let obj = intersects[0].object;
        while(obj.parent && obj.parent.type === "Group") { obj = obj.parent; }

        let d = obj.userData;
        if(!d.type) return; 

        let capText = '';
        if (d.type === 'tree') capText = `${d.capacity * 10} Bin Ağaç`;
        else if (d.type === 'house') capText = `${d.capacity} Blok (+${d.capacity * 50} İnsan)`;
        else capText = `${d.capacity} MW`;

        let emsText = d.ems < 0 ? `<span style='color:#2ecc71'>${d.ems.toFixed(1)} Siliyor</span>` : `<span style='color:#e74c3c'>+${d.ems.toFixed(1)} Üretiyor</span>`;
        let batText = d.type === 'battery' ? `<br>Bağlı: ${d.batteryTarget === 'solar'?'Güneş':'Rüzgar'}` : '';

        tooltip.innerHTML = `<b>${d.icon} ${d.name}</b><br>Kapasite: ${capText}<br>Gider: -${d.opex.toFixed(1)} 💰${batText}<br>CO2: ${emsText}<br>Alan: ${d.land.toFixed(1)} ha`;
        tooltip.style.left = (e.clientX - rect.left) + 'px'; tooltip.style.top = (e.clientY - rect.top) + 'px';
        tooltip.style.display = 'block';
    } else { tooltip.style.display = 'none'; }
});

container.addEventListener('click', (e) => {
    let rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ( (e.clientX - rect.left) / rect.width ) * 2 - 1;
    mouse.y = - ( (e.clientY - rect.top) / rect.height ) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    let intersects = raycaster.intersectObjects(meshes, true);
    
    if (intersects.length > 0) {
        let obj = intersects[0].object;
        while(obj.parent && obj.parent.type === "Group") { obj = obj.parent; }
        
        selectedMesh = obj;
        let d = selectedMesh.userData;
        if(!d.type) return;

        document.getElementById('actionTitle').innerText = `${d.icon} ${d.name} (${d.capacity} Birim)`;
        actionMenu.style.left = (e.clientX - rect.left) + 'px'; actionMenu.style.top = (e.clientY - rect.top) + 'px';
        actionMenu.style.display = 'block'; tooltip.style.display = 'none'; 
    } else { closeActionMenu(); }
});

function closeActionMenu() { actionMenu.style.display = 'none'; selectedMesh = null; }

function showPreview(type) { currentPreviewType = type; updateCostPreview(); }

function updateCostPreview() {
    let capacity = parseInt(document.getElementById('capacityInput').value) || 0;
    let zone = document.getElementById('zoneSelect').value;
    let plant = plants[currentPreviewType];
    let previewBox = document.getElementById('costPreviewBox');

    if (capacity <= 0) return;
    
    let totalCost = capacity * plant.costPerMw;
    let totalOpex = (capacity * plant.opexPerMw).toFixed(2);
    let totalEmission = (capacity * Math.abs(plant.emissionPerMw)).toFixed(2);
    let totalLand = (capacity * plant.landPerMw).toFixed(1);
    
    let warningHtml = "";
    if (zone === "city" && !plant.allowedInCity) warningHtml = `<br><span style="color: #e74c3c; font-weight: bold;">❌ DİKKAT: Halk itirazı! Fosil tesisler Şehir İçine kurulamaz.</span>`;
    
    let emsText = plant.emissionPerMw < 0 ? `<span style='color:#27ae60'>-${totalEmission} CO2 Siler</span>` : `+${totalEmission} CO2 Üretir`;
    
    let capText = '';
    if (currentPreviewType === 'tree') capText = `${capacity * 10} Bin Ağaç`;
    else if (currentPreviewType === 'house') capText = `${capacity} Blok Ev (+${capacity * 50} Kapasite)`;
    else capText = `${capacity} MW ${plant.name}`;

    previewBox.innerHTML = `
        <div style="font-size:15px; margin-bottom:5px;"><b>Planlanan:</b> ${plant.icon} ${capText}</div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:5px; font-size:13px;">
            <div><b>Yatırım:</b> <span style="color:#e67e22;">${totalCost.toLocaleString()} 💰</span></div>
            <div><b>Gider:</b> <span style="color:#e74c3c;">-${totalOpex} 💰/döngü</span></div>
            <div><b>Karbon Etkisi:</b> ${emsText}</div>
            <div><b>Arazi:</b> ${totalLand} ha</div>
        </div>
        ${warningHtml}
    `;
}

function updateUI() {
    document.getElementById('cityMaxDisplay').innerText = state.land.cityMax;
    document.getElementById('ruralMaxDisplay').innerText = state.land.ruralMax;
    document.getElementById('forestMaxDisplay').innerText = state.land.forestMax;
    document.getElementById('maxPopDisplay').innerText = state.maxPopulation;
}

function buildPlant(type) {
    let capacity = parseInt(document.getElementById('capacityInput').value);
    let zone = document.getElementById('zoneSelect').value;
    let plant = plants[type];
    
    if (isNaN(capacity) || capacity <= 0) return;
    if (zone === "city" && !plant.allowedInCity) { SoundEngine.error(); alert("Halk itirazı! Bu tesis şehir içine kurulamaz."); return; }
    
    if (zone === "forest" && type !== "tree") { SoundEngine.error(); alert("Hata: Orman alanına sadece Ağaç dikilebilir!"); return; }
    if (type === "tree" && zone !== "forest") { SoundEngine.error(); alert("Hata: Ağaçlar sadece Orman alanına dikilebilir!"); return; }
    if (type === "house" && zone !== "city") { SoundEngine.error(); alert("Hata: İnsanlar sadece Şehir İçi alanlara yerleşebilir!"); return; }

    let emptyTile = getNextEmptySlot(zone);
    if (!emptyTile) { SoundEngine.error(); alert(`Haritada yer kalmadı! Yukarıdan arazi satın al.`); return; }

    let landToAdd = capacity * plant.landPerMw;
    if (zone === "city" && (state.land.cityUsed + landToAdd > state.land.cityMax)) { SoundEngine.error(); alert("Şehirde yeterli arazi kalmadı! Arazi satın alın."); return; }
    if (zone === "rural" && (state.land.ruralUsed + landToAdd > state.land.ruralMax)) { SoundEngine.error(); alert("Kırsalda yeterli arazi kalmadı! Arazi satın alın."); return; }
    if (zone === "forest" && (state.land.forestUsed + landToAdd > state.land.forestMax)) { SoundEngine.error(); alert("Ormanda yer kalmadı! Arazi satın alın."); return; }

    let totalCost = capacity * plant.costPerMw;
    if (state.budget < totalCost) { SoundEngine.error(); alert("Yetersiz Bütçe!"); return; }

    let batteryTarget = "";
    if (type === 'battery') {
        let answer = prompt("Güneş için 'G', Rüzgar için 'R':").toUpperCase();
        if (answer !== 'G' && answer !== 'R') return;
        batteryTarget = answer === 'G' ? 'solar' : 'wind';
        let availableUnstored = state.installed[zone][batteryTarget] - state.installed[zone][batteryTarget + 'Storage'];
        if (capacity > availableUnstored) { alert("Yeterli boş tesis yok!"); return; }
    }

    SoundEngine.build();
    state.budget -= totalCost; 
    let emissionsToAdd = capacity * plant.emissionPerMw;
    let opexToAdd = capacity * plant.opexPerMw;

    state.emissions += emissionsToAdd;
    state.totalOpex += opexToAdd; 
    
    if (type === 'house') { state.installed[zone][type] += capacity; state.maxPopulation += (capacity * 50); }
    else if (type === 'battery') state.installed[zone][batteryTarget + 'Storage'] += capacity;
    else state.installed[zone][type] += capacity;
    
    if (zone === "city") state.land.cityUsed += landToAdd; 
    else if (zone === "rural") state.land.ruralUsed += landToAdd;
    else if (zone === "forest") state.land.forestUsed += landToAdd;

    emptyTile.isOccupied = true; // Zemin karesini dolu işaretle

    createMeshForPlant(type, plant.color, plant.geometry, plant.modelPath, function(mesh) {
        mesh.position.x = emptyTile.col - 9.5; 
        mesh.position.z = emptyTile.row - 9.5;

        mesh.userData = {
            type: type, name: plant.name, icon: plant.icon, zone: zone, color: plant.color,
            capacity: capacity, ems: emissionsToAdd, opex: opexToAdd, land: landToAdd,
            batteryTarget: batteryTarget, gridRef: emptyTile
        };

        scene.add(mesh);
        meshes.push(mesh);
    });
    
    updateUI();
}

window.triggerUpgrade = function() {
    if(!selectedMesh) return;
    let d = selectedMesh.userData;
    let plant = plants[d.type];
    
    let extraStr = prompt(`Kaç birim İLAVE etmek istiyorsunuz? (Birim Fiyat: ${plant.costPerMw} 💰)`);
    if (!extraStr) return;
    let extraCapacity = parseInt(extraStr);
    if (isNaN(extraCapacity) || extraCapacity <= 0) return;
    
    let extraCost = extraCapacity * plant.costPerMw;
    let extraLand = extraCapacity * plant.landPerMw;
    
    if (state.budget < extraCost) { SoundEngine.error(); alert("Yetersiz Bütçe!"); return; }
    if (d.zone === "city" && (state.land.cityUsed + extraLand > state.land.cityMax)) { SoundEngine.error(); alert("Arazi yetersiz!"); return; }
    if (d.zone === "rural" && (state.land.ruralUsed + extraLand > state.land.ruralMax)) { SoundEngine.error(); alert("Arazi yetersiz!"); return; }
    if (d.zone === "forest" && (state.land.forestUsed + extraLand > state.land.forestMax)) { SoundEngine.error(); alert("Arazi yetersiz!"); return; }
    
    SoundEngine.upgrade();
    state.budget -= extraCost;
    let extraEms = extraCapacity * plant.emissionPerMw;
    let extraOpex = extraCapacity * plant.opexPerMw;
    
    state.emissions += extraEms;
    state.totalOpex += extraOpex;
    
    if (d.type === 'house') { state.installed[d.zone][d.type] += extraCapacity; state.maxPopulation += (extraCapacity * 50); }
    else if (d.type === 'battery') state.installed[d.zone][d.batteryTarget + 'Storage'] += extraCapacity;
    else state.installed[d.zone][d.type] += extraCapacity;
    
    if (d.zone === "city") state.land.cityUsed += extraLand; 
    else if (d.zone === "rural") state.land.ruralUsed += extraLand;
    else if (d.zone === "forest") state.land.forestUsed += extraLand;
    
    d.capacity += extraCapacity;
    d.ems += extraEms; d.opex += extraOpex; d.land += extraLand;
    
    selectedMesh.scale.y += 0.2; selectedMesh.position.y += 0.1;
    closeActionMenu();
    updateUI();
};

window.triggerDemolish = function() {
    if(!selectedMesh) return;
    let d = selectedMesh.userData;

    if (confirm(`Tesisi söküyorsun. Onaylıyor musun?`)) {
        SoundEngine.demolish();
        state.emissions -= d.ems; 
        state.totalOpex = Math.max(0, state.totalOpex - d.opex);
        
        if (d.type === 'house') { state.installed[d.zone][d.type] -= d.capacity; state.maxPopulation -= (d.capacity * 50); }
        else if (d.type === 'battery') state.installed[d.zone][d.batteryTarget + 'Storage'] -= d.capacity;
        else state.installed[d.zone][d.type] -= d.capacity;
        
        if (d.zone === "city") state.land.cityUsed = Math.max(0, state.land.cityUsed - d.land);
        else if (d.zone === "rural") state.land.ruralUsed = Math.max(0, state.land.ruralUsed - d.land);
        else if (d.zone === "forest") state.land.forestUsed = Math.max(0, state.land.forestUsed - d.land);

        d.gridRef.isOccupied = false; // Zemini boşalt
        scene.remove(selectedMesh);
        meshes = meshes.filter(m => m !== selectedMesh);
        closeActionMenu();
        updateUI();
    }
};

// --- YENİ: ÇOKLU GÖREV SİSTEMİ ---
function getCapacity(type) {
    if(type==='pop') return state.population;
    let z = state.installed;
    if(type==='battery') return z.city.solarStorage + z.city.windStorage + z.rural.solarStorage + z.rural.windStorage; 
    return z.city[type] + z.rural[type] + z.forest[type];
}

function generateDailyGoal() {
    let types = ['solar', 'wind', 'battery', 'tree', 'house'];
    let t = types[Math.floor(Math.random() * types.length)];
    let current = getCapacity(t);
    let add = Math.floor(Math.random() * 3 + 2) * 10; // 20-50 birim arası ekle
    let target = current + add;
    let names = {solar: 'Güneş (MW)', wind: 'Rüzgar (MW)', battery: 'Depolama (MW)', tree: 'Ağaç (Birim)', house: 'Ev (Blok)'};
    return { type: t, target: target, reward: add * 400, desc: `${names[t]} kapasiteni ${target} yap` };
}

// Oyuna başlarken 3 görev oluştur
dailyGoals = [generateDailyGoal(), generateDailyGoal(), generateDailyGoal()];

function checkGoals() {
    let container = document.getElementById('daily-goals-container');
    let html = "";
    
    dailyGoals.forEach((goal, index) => {
        goal.current = getCapacity(goal.type);
        if (goal.current >= goal.target) {
            SoundEngine.goal();
            state.budget += goal.reward;
            alert(`🎉 GÜNLÜK GÖREV BAŞARILI: ${goal.desc}! \nKasa: +${goal.reward.toLocaleString()} 💰`);
            dailyGoals[index] = generateDailyGoal(); // Yenisini oluştur
        }
        html += `<div class="goal-item">📌 ${goal.desc}<br>Durum: ${goal.current} / ${goal.target} <br><span style="color:#27ae60;">Ödül: ${goal.reward.toLocaleString()} 💰</span></div>`;
    });
    
    container.innerHTML = html;

    // Genel Görev Kontrolü
    generalGoal.current = state.population;
    if (generalGoal.current >= generalGoal.target) {
        SoundEngine.goal();
        state.budget += generalGoal.reward;
        alert(`🏆 GENEL GÖREV BAŞARILI: ${generalGoal.desc}! \nKasa: +${generalGoal.reward.toLocaleString()} 💰`);
        let newTarget = generalGoal.target + 1000;
        generalGoal = { type: 'pop', target: newTarget, current: state.population, reward: newTarget * 30, desc: `Şehir nüfusunu ${newTarget}'e ulaştır` };
    }
    document.getElementById('generalGoalText').innerHTML = `🌟 <b>Genel Görev:</b> ${generalGoal.desc} <br> Durum: ${generalGoal.current} / ${generalGoal.target} Kişi <br><span style="color:#27ae60;">Ödül: ${generalGoal.reward.toLocaleString()} 💰</span>`;
}

// --- DÖNGÜ VE EFEKTLER ---
setInterval(() => {
    state.hour++;
    if (state.hour > 23) state.hour = 0;
    state.isDay = (state.hour >= 6 && state.hour <= 18);
    
    if (state.hour >= 6 && state.hour <= 9) state.solarEfficiency = 0.4;
    else if (state.hour >= 10 && state.hour <= 14) state.solarEfficiency = 1.0;
    else if (state.hour >= 15 && state.hour <= 18) state.solarEfficiency = 0.6;
    else state.solarEfficiency = 0.0;

    if (Math.random() > 0.8) state.windEfficiency = (Math.floor(Math.random() * 60) + 40) / 100;

    meshes.forEach(m => { if (m.userData && m.userData.isWind && m.userData.blade) { m.userData.blade.rotation.z += (0.5 * state.windEfficiency); } });

    let isPolluted = state.emissions > 50;
    let targetFogDensity = 0;
    if (isPolluted) { scene.background.lerp(new THREE.Color('#7f8c8d'), 0.1); targetFogDensity = Math.min((state.emissions - 50) * 0.001, 0.08); } 
    else { if(state.isDay) scene.background.lerp(new THREE.Color('#ecf0f1'), 0.1); else scene.background.lerp(new THREE.Color('#1a252f'), 0.1); }
    scene.fog.density += (targetFogDensity - scene.fog.density) * 0.1;

    meshes.forEach(mesh => {
        if (!state.isDay && mesh.userData && mesh.userData.type !== 'tree') {
            mesh.children.forEach(child => { if(child.material) { child.material.emissive.setHex(mesh.userData.color); child.material.emissiveIntensity = 0.4; } });
        } else {
            mesh.children.forEach(child => { if(child.material) child.material.emissive.setHex(0x000000); });
        }
    });

    function calcProduction(zoneStr) {
        let z = state.installed[zoneStr];
        let base = z.coal + z.gas + z.geo + z.hydro;
        let rawSolar = z.solar * state.solarEfficiency;
        let solarOutput = 0; let solarBatteryOutput = 0;

        if (state.isDay) { let chargeAmount = Math.min(rawSolar, z.solarStorage); solarOutput = rawSolar - chargeAmount; solarBatteryOutput = 0; } 
        else { solarOutput = 0; solarBatteryOutput = z.solarStorage; }

        let rawWind = z.wind * state.windEfficiency;
        let windOutput = 0; let windBatteryOutput = 0;

        if (state.windEfficiency > 0.5) { let chargeAmount = Math.min(rawWind, z.windStorage); windOutput = rawWind - chargeAmount; windBatteryOutput = 0; } 
        else { windOutput = rawWind; windBatteryOutput = z.windStorage; }

        return { total: base + solarOutput + solarBatteryOutput + windOutput + windBatteryOutput, coal: z.coal, gas: z.gas, geo: z.geo, hydro: z.hydro, solar: solarOutput, wind: windOutput, stored: solarBatteryOutput + windBatteryOutput };
    }

    let cityData = calcProduction("city"); let ruralData = calcProduction("rural");
    
    let coalProd = cityData.coal + (ruralData.coal * 0.9); let gasProd = cityData.gas + (ruralData.gas * 0.9);
    let solarProd = cityData.solar + (ruralData.solar * 0.9); let windProd = cityData.wind + (ruralData.wind * 0.9);
    let baseProd = cityData.geo + cityData.hydro + ((ruralData.geo + ruralData.hydro) * 0.9);
    let storedProd = cityData.stored + (ruralData.stored * 0.9);

    let totalNetProduction = coalProd + gasProd + solarProd + windProd + baseProd + storedProd;
    let currentDemand = state.population * state.demandPerPerson;
    
    let soldEnergy = Math.min(totalNetProduction, currentDemand);
    let wastedEnergy = Math.max(0, totalNetProduction - currentDemand);
    let netEnergy = totalNetProduction - currentDemand;

    let income = soldEnergy * state.incomePerMw;
    let expense = state.totalOpex;
    let displayEms = Math.max(0, state.emissions); 
    let carbonTax = displayEms > 50 ? (displayEms - 50) * 1.5 : 0; 

    // BÜTÇE GÜNCELLEMESİ
    state.budget += (income - expense - carbonTax);

    // NÜFUS ARTIŞI
    if (totalNetProduction >= currentDemand && state.population < state.maxPopulation) state.population += 1;
    else if (totalNetProduction < currentDemand) state.population -= 1;

    document.getElementById('budget').innerText = Math.floor(state.budget).toLocaleString();
    document.getElementById('emissions').innerText = displayEms.toFixed(1);
    
    document.getElementById('population').innerText = Math.floor(state.population);
    document.getElementById('demand').innerText = Math.floor(currentDemand);
    
    document.getElementById('energy').innerText = Math.floor(totalNetProduction);
    document.getElementById('soldEnergy').innerText = Math.floor(soldEnergy);
    
    document.getElementById('cityLand').innerText = Math.floor(state.land.cityUsed);
    document.getElementById('ruralLand').innerText = Math.floor(state.land.ruralUsed);
    document.getElementById('forestLand').innerText = Math.floor(state.land.forestUsed);
    
    let breakdownHtml = `<span style="color:#2ecc71;">+${income.toFixed(1)} 💰 Gelir</span> | <span style="color:#e74c3c;">-${expense.toFixed(1)} 💰 Gider</span>`;
    if (carbonTax > 0) breakdownHtml += ` | <span class="tax-alert">-${carbonTax.toFixed(1)} 💰 Vergi</span>`;
    document.getElementById('budgetBreakdown').innerHTML = breakdownHtml;

    let bdHtml = "";
    if(coalProd > 0) bdHtml += `<div class="income-row"><span>🏭 Kömür:</span> <span>${coalProd.toFixed(1)} MW</span></div>`;
    if(gasProd > 0) bdHtml += `<div class="income-row"><span>🔥 Doğalgaz:</span> <span>${gasProd.toFixed(1)} MW</span></div>`;
    if(solarProd > 0) bdHtml += `<div class="income-row"><span>☀️ Güneş:</span> <span>${solarProd.toFixed(1)} MW</span></div>`;
    if(windProd > 0) bdHtml += `<div class="income-row"><span>🌬️ Rüzgar:</span> <span>${windProd.toFixed(1)} MW</span></div>`;
    if(baseProd > 0) bdHtml += `<div class="income-row"><span>🌋/🌊 Sabit Temiz:</span> <span>${baseProd.toFixed(1)} MW</span></div>`;
    if(storedProd > 0) bdHtml += `<div class="income-row"><span>🔋 Batarya:</span> <span style="color:#2ecc71;">${storedProd.toFixed(1)} MW</span></div>`;
    
    document.getElementById('breakdownDetails').innerHTML = bdHtml || "Henüz üretim yapan santral yok.";

    document.getElementById('clockDisplay').innerText = (state.isDay ? "🌞 " : "🌙 ") + (state.hour < 10 ? "0" : "") + state.hour + ":00";
    document.getElementById('solarDisplay').innerText = `Güneş: %${Math.floor(state.solarEfficiency * 100)}`;
    document.getElementById('windDisplay').innerText = `Rüzgar: %${Math.floor(state.windEfficiency * 100)}`;
    
    let advisorDiv = document.getElementById('advisor-message');
    let currentAdvisorState = 'warning';
    if (displayEms > 50) {
        advisorDiv.innerHTML = `🚨 DANIŞMAN: Bütçen karbon vergisinden eriyor (-${carbonTax.toFixed(1)} 💰). Fosil yakıtları sök veya acilen <b>Ağaç Dik</b>!`;
        advisorDiv.className = "danger-advisor";
        currentAdvisorState = 'danger';
    } else if (netEnergy < 0) {
        advisorDiv.innerHTML = `🚨 DANIŞMAN: Elektrik yetersiz! Şebeke çöküyor, nüfus azalıyor. Hemen yatırım yap veya <b>Depolama</b> kur!`;
        advisorDiv.className = "danger-advisor";
        currentAdvisorState = 'danger';
    } else if (state.population >= state.maxPopulation && totalNetProduction >= currentDemand) {
        advisorDiv.innerHTML = `⚠️ DANIŞMAN: Şehirde boş ev kalmadı! Nüfusun artması için yeni <b>Ev Kur</b> veya <b>Arazi Satın Al</b>.`;
        advisorDiv.className = "warning-advisor";
        currentAdvisorState = 'warning';
    } else if (wastedEnergy > 20) {
        advisorDiv.innerHTML = `⚠️ DANIŞMAN: ${Math.floor(wastedEnergy)} MW israf var. Gelir getirmiyor ama bakım masrafı kesiliyor! Tesis sök.`;
        advisorDiv.className = "warning-advisor";
        currentAdvisorState = 'warning';
    } else {
        advisorDiv.innerHTML = `✅ DANIŞMAN: Şebeke kusursuz işliyor. Elektrik talebi tam karşılanıyor, şehir büyüyor.`;
        advisorDiv.className = "success-advisor";
        currentAdvisorState = 'good';
    }

    // Durum değiştiğinde (her 2.5sn'de bir değil, sadece geçişte) sesli uyarı ver
    if (currentAdvisorState !== lastAdvisorState) {
        if (currentAdvisorState === 'danger') SoundEngine.stateAlarm();
        else if (currentAdvisorState === 'good' && lastAdvisorState !== null) SoundEngine.stateGood();
        lastAdvisorState = currentAdvisorState;
    }

    checkGoals();

}, 2500);
