// --- SİMÜLASYON DURUMU ---
let state = {
    budget: 100000, emissions: 0, totalOpex: 0,
    population: 1000, maxPopulation: 1000,
    hour: 8, isDay: true,
    land: { cityUsed: 0, cityMax: 500, ruralUsed: 0, ruralMax: 9000, forestUsed: 0, forestMax: 1000 },
    expansions: { city: 0, rural: 0, forest: 0 }, // Yeni eklenen zemin sayısını tutar
    installed: {
        city: { coal:0, gas:0, geo:0, hydro:0, solar:0, wind:0, solarStorage:0, windStorage:0, tree:0, house: 20 },
        rural: { coal:0, gas:0, geo:0, hydro:0, solar:0, wind:0, solarStorage:0, windStorage:0, tree:0, house:0 },
        forest: { coal:0, gas:0, geo:0, hydro:0, solar:0, wind:0, solarStorage:0, windStorage:0, tree:0, house:0 }
    },
    plantCounts: { coal:0, gas:0, geo:0, hydro:0, solar:0, wind:0, battery:0, tree:0, house:20 },
    solarStorageCharge: 0, windStorageCharge: 0, // Güneşe/rüzgara bağlı depoların o anki dolu miktarı (MWh) - birbirinden bağımsız
    solarFactor: 0.0, windFactor: 0.33, // Güneş/rüzgar için gün boyu değişen anlık kapasite faktörü
    dailyGoalTicks: 0,
    loginRewardTicks: 0
};

let dailyLoginRewardGrantedDuringCatchup = false; // Uzaktayken geçen sürede birden fazla gün geçse bile ödül sadece 1 kez verilsin

let gameLoop;

// 1 MW kurulu güç başına saatlik ortalama üretim (kapasite faktörü, MWh) - sadece sabit kaynaklar için
const CAPACITY_FACTOR = { coal: 0.75, gas: 0.63, geo: 0.83, hydro: 0.46 };

// Güneş, saate göre gün boyu değişir (kullanıcının belirttiği tam oranlar, gece 0)
function getSolarFactor(hour) {
    if (hour === 6) return 0.10;
    if (hour === 7 || hour === 8) return 0.30;
    if (hour === 9) return 0.50;
    if (hour === 10 || hour === 11) return 0.80;
    if (hour >= 12 && hour <= 15) return 1.00;
    if (hour === 16) return 0.80;
    if (hour === 17) return 0.50;
    if (hour === 18) return 0.30;
    if (hour === 19) return 0.10;
    return 0.0; // 20:00 - 06:00 arası güneş üretmez
}

// Kişi başı saatlik tüketim, güne göre değişir (akşam yüksek, gece düşük, gündüz normal)
function getCurrentDemandPerPerson() {
    if (state.hour >= 18 && state.hour < 24) return 0.030; // Akşam: 1000 kişi -> 30 MWh (%20 artırıldı)
    if (state.hour >= 7 && state.hour < 18) return 0.024;  // Gündüz: 1000 kişi -> 24 MWh (%20 artırıldı)
    return 0.018;                                           // Gece: 1000 kişi -> 18 MWh (%20 artırıldı)
}

// Zamana göre değişen satış fiyatı (💰/MWh)
function getCurrentPrice() {
    if (state.hour >= 7 && state.hour < 18) return 5.0;   // Gündüz
    if (state.hour >= 18 && state.hour < 24) return 7.0;  // Akşam
    return 4.0;                                            // Gece (00:00-07:00)
}

// Her 1200 döngüde (yaklaşık bir gerçek gün) santralin kaybettiği sağlık puanı
const HEALTH_DECAY_PER_1200 = { hydro: 0.02, solar: 0.04, wind: 0.06, geo: 0.07, coal: 0.10, gas: 0.12, battery: 0.20 };
// MW başına bakım maliyeti (💰) - baz değerler
const MAINTENANCE_COST_PER_MW = { hydro: 6, solar: 12, wind: 18, geo: 24, battery: 30, coal: 36, gas: 42 };
const MAINTENANCE_COST_MULTIPLIER = 5; // Bakım maliyetleri genel olarak 5 kat artırıldı
// Arıza olasılığı: ortalama her 1200 döngüde bir santral arıza verir
const BREAKDOWN_CHANCE_PER_TICK = 1 / 600;
// Baz yük kısıtı: kurulu gücün en az %40'ı bu tiplerden olmak zorunda
const BASELOAD_TYPES = ['coal', 'gas', 'geo'];
const BASELOAD_MIN_RATIO = 0.40;

function getMaintenanceMultiplier(health) {
    if (health > 70) return 1;
    if (health >= 50) return 2;
    if (health >= 10) return 3;
    return null; // %10 altı: bakım yapılamaz
}

function updateMaintenancePanel() {
    let panel = document.getElementById('maintenanceDetails');
    if (!panel) return;
    let list = structures.filter(s => HEALTH_DECAY_PER_1200[s.type] !== undefined).slice().sort((a, b) => a.health - b.health);
    if (list.length === 0) { panel.innerHTML = "Henüz bakım gerektiren bir tesis yok."; return; }

    let html = "";
    list.forEach(s => {
        let plant = plants[s.type];
        let health = (s.health === undefined || s.health === null) ? 100 : s.health;
        let zoneName = s.zone === 'city' ? 'Şehir' : s.zone === 'rural' ? 'Kırsal' : 'Orman';
        let btnHtml, statusText, color;

        if (s.broken) {
            color = '#c0392b';
            statusText = '⚠️ ARIZALI (Üretim Durdu)';
            let fixCost = Math.round(s.capacity * (plant.costPerMw / 5));
            btnHtml = `<button class="build-btn" style="background:#e67e22; color:#fff;" onclick="fixBreakdown(${s.row},${s.col})">⚙️ Arızayı Gider (${fixCost.toLocaleString()} 💰)</button>`;
        } else {
    let mult = getMaintenanceMultiplier(health);
    color = health < 10 ? '#7f8c8d' : (health > 70 ? '#27ae60' : (health >= 50 ? '#f39c12' : '#e74c3c'));
    statusText = health < 10 ? 'KAPANDI ⛔' : `%${health.toFixed(0)}`;
    if (Math.round(health) >= 100) {
        btnHtml = `<span style="color:#27ae60; font-weight:bold;">✅ Sağlıklı</span>`;
    } else if (mult === null) {
        btnHtml = `<button class="build-btn" style="background:#7f8c8d; color:#fff; opacity:0.7;" disabled>Kapandı - Sökülmeli</button>`;
    } else {
        let cost = Math.round(s.capacity * MAINTENANCE_COST_PER_MW[s.type] * mult * MAINTENANCE_COST_MULTIPLIER);
        btnHtml = `<button class="build-btn" style="background:#16a085; color:#fff;" onclick="repairPlant(${s.row},${s.col})">🔧 Bakım Yap (${cost.toLocaleString()} 💰)</button>`;
    }
}

        html += `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid #ecf0f1; flex-wrap:wrap;">
            <div style="min-width:140px;">
                <div><b>${plant.icon} ${plant.name}${s.type === 'battery' ? (s.batteryTarget === 'wind' ? ' (🌬️ Rüzgar)' : ' (☀️ Güneş)') : ''}</b> — ${s.capacity} MW (${zoneName})</div>
                <div style="font-size:12px; color:${color}; font-weight:bold;">${s.broken ? statusText : 'Sağlık: ' + statusText}</div>
            </div>
            ${btnHtml}
        </div>`;
    });
    panel.innerHTML = html;
}

window.repairPlant = function (row, col) {
    let s = structures.find(st => st.row === row && st.col === col);
    if (!s) return;
    if (s.broken) { showAlert("Bu tesis arızalı, önce arızayı gidermen gerekiyor."); return; }
    let health = (s.health === undefined || s.health === null) ? 100 : s.health;
    if (Math.round(health) >= 100) { showAlert("Bu tesis zaten tam sağlıklı, bakıma gerek yok."); return; }
    let mult = getMaintenanceMultiplier(health);
    let plant = plants[s.type];

    if (mult === null) { SoundEngine.error(); showAlert(`Bu tesisin sağlığı %10'un altına düştü, artık bakım yapılamaz. Söküp yeniden kurman gerekiyor.`); return; }

    let cost = Math.round(s.capacity * MAINTENANCE_COST_PER_MW[s.type] * mult * MAINTENANCE_COST_MULTIPLIER);
    showConfirm(
        `🔧 ${plant.icon} ${plant.name} BAKIMI\n\nMevcut Sağlık: %${health.toFixed(0)}\nMaliyet Çarpanı: ${mult}x (x${MAINTENANCE_COST_MULTIPLIER})\nToplam Maliyet: ${cost.toLocaleString()} 💰\n\nBakım yapılıp sağlık %100'e çıkarılsın mı?`,
        function () {
            if (state.budget < cost) { SoundEngine.error(); showAlert("Yetersiz Bütçe!"); return; }
            state.budget -= cost;
            s.health = 100;
            SoundEngine.upgrade();
            showAlert(`✅ ${plant.icon} ${plant.name} bakımı tamamlandı! Sağlık %100'e çıktı.`);
            updateMaintenancePanel();
            updateUI();
            saveGame();
        }
    );
};

window.fixBreakdown = function (row, col) {
    let s = structures.find(st => st.row === row && st.col === col);
    if (!s || !s.broken) return;
    let plant = plants[s.type];
    let cost = Math.round(s.capacity * (plant.costPerMw / 5));

    showConfirm(
        `⚙️ ${plant.icon} ${plant.name} ARIZA GİDERME\n\nTesis arızalı, üretim durmuş durumda.\nMaliyet: ${cost.toLocaleString()} 💰\n\nArıza giderilsin mi?`,
        function () {
            if (state.budget < cost) { SoundEngine.error(); showAlert("Yetersiz Bütçe!"); return; }
            state.budget -= cost;
            s.broken = false;
            s.alertDismissed = false; // Tesis onarıldığı için gizleme durumunu temizle
            SoundEngine.upgrade();
            showAlert(`✅ ${plant.icon} ${plant.name} arızası giderildi, üretime devam ediyor.`);
            updateMaintenancePanel();
            updateUI();
            saveGame();
        }
    );
};

let currentPreviewType = 'solar'; 
let lastAdvisorState = null; // Danışman durumu değiştiğinde tekrar tekrar ses çalmamak için
let simulatingOffline = false; // Uzaktayken geçen süre hesaplanırken ses/alert bastırılır
let structures = []; // Kurulan her tesisin {type, zone, capacity, row, col, batteryTarget} kaydı (kayıt/yükleme için)

// HEDEFLER (GÖREVLER) - 3 Günlük, 1 Genel
let dailyGoals = [];
let generalGoal = { type: 'pop', target: 1500, current: 1000, reward: 10000, desc: "Şehir nüfusunu 1500'e ulaştır" };

const plants = {
    gas:     { costPerMw: 1500, emissionPerMw: 0.8, opexPerMw: 3.0, landPerMw: 0.1, allowedInCity: false, name: "Doğalgaz", icon: "🔥", color: 0xe67e22, geometry: 'cylinder', modelPath: 'assets/models/power/gas.glb' },
    coal:    { costPerMw: 2500, emissionPerMw: 1.5, opexPerMw: 1.5, landPerMw: 0.2, allowedInCity: false, name: "Kömür", icon: "🏭", color: 0x34495e, geometry: 'box_tall', modelPath: 'assets/models/power/coal.glb' },
    geo:     { costPerMw: 4000, emissionPerMw: 0,   opexPerMw: 0.4, landPerMw: 0.5, allowedInCity: false, name: "Jeotermal", icon: "🌋", color: 0xe74c3c, geometry: 'cylinder_low', modelPath: 'assets/models/power/geo.glb' },
    hydro:   { costPerMw: 3000, emissionPerMw: 0,   opexPerMw: 0.15,landPerMw: 20.0,allowedInCity: false, name: "Hidrolik", icon: "🌊", color: 0x0984e3, geometry: 'box_wide', modelPath: 'assets/models/power/hydro.glb' },
    wind:    { costPerMw: 1800, emissionPerMw: 0,   opexPerMw: 0.45,landPerMw: 10.0,allowedInCity: false, name: "Rüzgar", icon: "🌬️", color: 0xffffff, geometry: 'turbine', modelPath: 'assets/models/power/wind.glb' },
    solar:   { costPerMw: 800,  emissionPerMw: 0,   opexPerMw: 0.15,landPerMw: 3.0, allowedInCity: true,  name: "Güneş", icon: "☀️", color: 0x111111, geometry: 'panel', modelPath: 'assets/models/power/solar.glb' },
    battery: { costPerMw: 1500, emissionPerMw: 0,   opexPerMw: 0.15,landPerMw: 0.1, allowedInCity: true,  name: "Depolama", icon: "🔋", color: 0x8e44ad, geometry: 'box', modelPath: 'assets/models/power/battery.glb' },
    tree:    { costPerMw: 100, emissionPerMw:-0.08, opexPerMw: 0, landPerMw: 1.0, allowedInCity: false, name: "Orman", icon: "🌳", color: 0x27ae60, geometry: 'cone', modelPath: 'assets/models/power/tree.glb' },
    house:   { costPerMw: 2000, emissionPerMw: 0.1, opexPerMw: 0, landPerMw: 5.0, allowedInCity: true,  name: "Yerleşim", icon: "🏠", color: 0xecf0f1, geometry: 'house', modelPath: 'assets/models/buildings/house.glb' }
};

// --- YENİ: EKRAN ÜSTÜ ARIZA BİLDİRİM PANELİ ---
const breakdownOverlay = document.createElement('div');
breakdownOverlay.id = 'breakdown-overlay';
breakdownOverlay.style.cssText = 'position: fixed; top: 75px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; pointer-events: none;';
document.body.appendChild(breakdownOverlay);

function updateBreakdownAlerts() {
    let overlay = document.getElementById('breakdown-overlay');
    if (!overlay) return;

    // Sadece arızalı olan VE kullanıcı tarafından (Çarpı ile) henüz gizlenmemiş olanları bul
    let brokenPlants = structures.filter(s => s.broken && !s.alertDismissed);
    
    if (brokenPlants.length === 0) {
        overlay.innerHTML = '';
        return;
    }

    let html = '';
    brokenPlants.forEach(s => {
        let plant = plants[s.type];
        let fixCost = Math.round(s.capacity * (plant.costPerMw / 5));
        let zoneName = s.zone === 'city' ? 'Şehir' : s.zone === 'rural' ? 'Kırsal' : 'Orman';
        
        html += `
        <div style="background: rgba(192, 57, 43, 0.95); color: white; padding: 15px; border-radius: 8px; box-shadow: 0 5px 15px rgba(0,0,0,0.5); width: 280px; position: relative; border-left: 5px solid #f1c40f; pointer-events: auto; animation: slideDown 0.3s ease;">
            <div style="font-weight: bold; font-size: 14px; margin-bottom: 5px; color:#f1c40f;">⚠️ ARIZA TESPİT EDİLDİ</div>
            <div style="font-size: 13px; margin-bottom: 12px; line-height: 1.4;">
                <b>${plant.icon} ${plant.name}</b> (${s.capacity} MW)<br>
                <span style="font-size: 11px; opacity: 0.8;">Bölge: ${zoneName} - Üretim durdu!</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
                <button style="background: #f1c40f; color: #2c3e50; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 12px;" onclick="fixBreakdown(${s.row}, ${s.col})">🔧 Onar (${fixCost.toLocaleString()} 💰)</button>
            </div>
            <button style="position: absolute; top: 8px; right: 8px; background: transparent; border: none; color: white; font-size: 18px; cursor: pointer; opacity: 0.7;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.7" onclick="dismissBreakdownAlert(${s.row}, ${s.col})">✖</button>
        </div>
        `;
    });
    overlay.innerHTML = html;
}

window.dismissBreakdownAlert = function(row, col) {
    let s = structures.find(st => st.row === row && st.col === col);
    if (s) {
        s.alertDismissed = true; // Uyarıyı kullanıcı "gördüm ve kapattım" olarak işaretle
        updateBreakdownAlerts(); // Ekranı güncelle
    }
};

// --- SES MOTORU (Harici dosya gerektirmez, tarayıcıda anlık üretilir; sadece bildirim sesleri) ---
window.SoundEngine = (function () {
    let ctx = null;
    let enabled = true;
    let isBackgrounded = false; // Arka plandayken ses motoru hiçbir şekilde ses üretmez/kontexti açmaz
    try {
        const saved = localStorage.getItem('ecogrid_sound_enabled');
        if (saved !== null) enabled = saved === '1';
    } catch (e) { /* localStorage yoksa sessizce devam et */ }

    function getCtx() {
        if (!enabled || isBackgrounded) return null; // ARKA PLANDAYKEN: asla context açma/resume etme
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
        // Gerçek susturma: bağlamı tamamen askıya alır, hiçbir ses (planlanmış olsa bile) duyulmaz
        toggle: function () {
            enabled = !enabled;
            try { localStorage.setItem('ecogrid_sound_enabled', enabled ? '1' : '0'); } catch (e) {}
            if (enabled) { getCtx(); beep(440, 0.08, 'sine', 0.1); }
            else if (ctx && ctx.state !== 'suspended') { ctx.suspend(); }
            return enabled;
        },
        isEnabled: function () { return enabled; },
        // Uygulama arka plana alındığında çağrılır: ses tamamen susar
        suspendForBackground: function () { isBackgrounded = true; if (ctx && ctx.state === 'running') ctx.suspend(); },
        // Uygulama tekrar öne geldiğinde çağrılır: kullanıcı sesi kapatmadıysa devam eder
        resumeFromBackground: function () { isBackgrounded = false; if (enabled && ctx && ctx.state === 'suspended') ctx.resume(); }
    };
})();

// Sekme/uygulama arka plana alınınca sesi tamamen kes, öne gelince (kullanıcı kapatmadıysa) devam ettir
document.addEventListener('visibilitychange', function () {
    if (document.hidden) window.SoundEngine.suspendForBackground();
    else window.SoundEngine.resumeFromBackground();
});
window.addEventListener('blur', function () { window.SoundEngine.suspendForBackground(); });
window.addEventListener('focus', function () { window.SoundEngine.resumeFromBackground(); });
// YEDEK MEKANİZMA: Bazı WebView sarmalayıcılarında (Appilix/WebIntoApp vb.)
// visibilitychange/blur olayları arka plana alındığında hiç tetiklenmiyor.
// Bu yüzden document.hidden durumunu düzenli aralıklarla da kontrol ediyoruz.
let wasHiddenLastCheck = document.hidden;
setInterval(function () {
    if (document.hidden !== wasHiddenLastCheck) {
        wasHiddenLastCheck = document.hidden;
        if (document.hidden) window.SoundEngine.suspendForBackground();
        else window.SoundEngine.resumeFromBackground();
    }
}, 1000); // her 1 saniyede bir kontrol et

// --- ÖZEL BİLDİRİM PENCERESİ (tarayıcının "site diyor ki" ön ekini tamamen ortadan kaldırır) ---
(function () {
    const style = document.createElement('style');
    style.textContent = `
        .ecogrid-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 99999; display: none; align-items: center; justify-content: center; padding: 20px; }
        .ecogrid-modal-overlay.open { display: flex; }
        .ecogrid-modal-box { background: #fff; border-radius: 12px; max-width: 360px; width: 100%; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); font-family: inherit; }
        .ecogrid-modal-title { font-weight: bold; font-size: 16px; margin-bottom: 10px; color: #2c3e50; white-space: pre-wrap; }
        .ecogrid-modal-input { width: 100%; box-sizing: border-box; padding: 10px; font-size: 15px; border: 2px solid #3498db; border-radius: 6px; margin-top: 8px; margin-bottom: 4px; font-weight: bold; }
        .ecogrid-modal-buttons { display: flex; gap: 10px; margin-top: 16px; justify-content: flex-end; }
        .ecogrid-modal-buttons button { padding: 10px 18px; border: none; border-radius: 6px; font-weight: bold; font-size: 14px; cursor: pointer; }
        .ecogrid-modal-buttons .primary { background: #3498db; color: #fff; }
        .ecogrid-modal-buttons .secondary { background: #ecf0f1; color: #2c3e50; }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'ecogrid-modal-overlay';
    overlay.innerHTML = `
        <div class="ecogrid-modal-box">
            <div class="ecogrid-modal-title" id="ecogridModalTitle"></div>
            <input class="ecogrid-modal-input" id="ecogridModalInput" style="display:none;" />
            <div class="ecogrid-modal-buttons" id="ecogridModalButtons"></div>
        </div>`;
    document.body.appendChild(overlay);

    const titleEl = overlay.querySelector('#ecogridModalTitle');
    const inputEl = overlay.querySelector('#ecogridModalInput');
    const buttonsEl = overlay.querySelector('#ecogridModalButtons');

    function close() { overlay.classList.remove('open'); }
    function open(message, showInput, defaultValue) {
        titleEl.innerText = message;
        if (showInput) { inputEl.style.display = 'block'; inputEl.value = defaultValue || ''; setTimeout(() => inputEl.focus(), 50); }
        else { inputEl.style.display = 'none'; }
        buttonsEl.innerHTML = '';
        overlay.classList.add('open');
    }
    function addButton(label, primary, onClick) {
        const btn = document.createElement('button');
        btn.className = primary ? 'primary' : 'secondary';
        btn.innerText = label;
        btn.onclick = onClick;
        buttonsEl.appendChild(btn);
        return btn;
    }

    // alert() yerine: sadece "Tamam" butonu olan bilgi penceresi
    window.showAlert = function (message) {
        open(message, false);
        addButton('Tamam', true, close);
    };
    // confirm() yerine: Evet/Hayır seçenekli, onaylanınca callback çalışır
    window.showConfirm = function (message, onYes) {
        open(message, false);
        addButton('Hayır', false, close);
        addButton('Evet', true, function () { close(); onYes(); });
    };
    // prompt() yerine: metin girişli, Tamam'a basınca callback(value) çalışır
    window.showPrompt = function (message, defaultValue, onSubmit) {
        open(message, true, defaultValue);
        addButton('İptal', false, close);
        addButton('Tamam', true, function () { let v = inputEl.value; close(); onSubmit(v); });
        inputEl.onkeydown = function (e) { if (e.key === 'Enter') { let v = inputEl.value; close(); onSubmit(v); } };
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
controls.enableRotate = false; // Grid'in dönmesine gerek yok, sabit açıdan bakılsın
controls.maxPolarAngle = Math.PI / 2 - 0.05; 

// Tüm zemin ve yapılar bu grup içine eklenir; harita genişledikçe bu grubu kaydırarak
// görünümü her zaman ortalı tutuyoruz (döndürme yok, sadece merkezleme).
const worldGroup = new THREE.Group();
scene.add(worldGroup);
let maxRowUsed = 19;
function recenterWorld() {
    worldGroup.position.z = (19 - maxRowUsed) / 2;
}

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

    worldGroup.add(tileMesh);
    if (row > maxRowUsed) maxRowUsed = row;
    
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

// --- KAYIT / YÜKLEME SİSTEMİ (sayfa yenilense veya uygulama kapansa bile ilerleme kaybolmaz) ---
const SAVE_KEY = 'ecogrid_save_v1';
function saveGame() {
    try {
        localStorage.setItem(SAVE_KEY, JSON.stringify({
            state: state, dailyGoals: dailyGoals, generalGoal: generalGoal,
            structures: structures, savedAt: Date.now()
        }));
    } catch (e) { /* depolama erişilemezse sessizce geç */ }
}

function loadGame() {
    let raw;
    try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    let data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (!data || !data.state) return false;

    state = Object.assign(state, data.state);
    dailyGoals = data.dailyGoals || dailyGoals;
    generalGoal = data.generalGoal || generalGoal;
    structures = data.structures || [];
    structures.forEach(s => { if (s.health === undefined || s.health === null) s.health = 100; if (s.broken === undefined) s.broken = false; });

    // Satın alınmış ek arazileri (expansions) aynı algoritmayla tekrar çiz
    ['city', 'rural', 'forest'].forEach(type => {
        let totalExp = state.expansions[type] || 0;
        for (let i = 0; i < totalExp; i++) {
            let r = 0, c = 0;
            if (type === 'city') { r = 20 + Math.floor(i / 2); c = i % 2; }
            else if (type === 'forest') { r = 20 + Math.floor(i / 2); c = 18 + (i % 2); }
            else if (type === 'rural') { r = 20 + Math.floor(i / 16); c = 2 + (i % 16); }
            createGroundTile(r, c, type);
        }
    });
    recenterWorld();

    // Kayıtlı tesisleri sahneye geri koy
    structures.forEach(s => {
        let tile = gridMap.find(t => t.row === s.row && t.col === s.col && t.zone === s.zone);
        let plant = plants[s.type];
        if (!tile || !plant) return;
        tile.isOccupied = true;
        createMeshForPlant(s.type, plant.color, plant.geometry, plant.modelPath, function (mesh) {
            mesh.position.x = s.col - 9.5;
            mesh.position.z = s.row - 9.5;
            mesh.userData = {
                type: s.type, name: plant.name, icon: plant.icon, zone: s.zone, color: plant.color,
                capacity: s.capacity, ems: s.capacity * plant.emissionPerMw, opex: s.capacity * plant.opexPerMw,
                land: s.capacity * plant.landPerMw, batteryTarget: s.batteryTarget || '', gridRef: tile
            };
            worldGroup.add(mesh);
            meshes.push(mesh);
        });
    });

    // Uygulama kapalıyken/uzaktayken geçen süreyi hızlıca simüle et (arka planda "devam etmiş" gibi)
    let elapsedSeconds = (Date.now() - (data.savedAt || Date.now())) / 1000;
    let ticksToSimulate = Math.min(Math.floor(elapsedSeconds / 2.5), 400); // ~16 güne kadar telafi
    if (ticksToSimulate > 1) {
        simulatingOffline = true;
        let startBudget = state.budget;
        dailyLoginRewardGrantedDuringCatchup = false;
        for (let i = 0; i < ticksToSimulate; i++) runTick();
        simulatingOffline = false;
        let deltaBudget = Math.floor(state.budget - startBudget);
        setTimeout(() => {
            showAlert(`⏱️ Uzaktayken geçen sürede şebeke ${ticksToSimulate} saat çalıştı.\nKasa değişimi: ${deltaBudget >= 0 ? '+' : ''}${deltaBudget.toLocaleString()} 💰\nNüfus: ${Math.floor(state.population)} kişi`);
        }, 400);
    }
    return true;
}

window.resetGame = function () {
    showConfirm(
        "⚠️ OYUNU SIFIRLA\n\nTüm ilerlemen (kasa, kurulu santraller, nüfus, arazi, görevler) silinecek ve oyun sıfırdan başlayacak.\n\nBu işlem GERİ ALINAMAZ. Emin misin?",
        function () {
            try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
            location.reload();
        }
    );
};

// Kayıtlı oyun varsa yükle, yoksa sıfırdan başla
if (!loadGame()) {
    generateInitialCity();
}
updateUI(); // Kaydedilmiş kapasite/arazi değerlerini ekrana hemen yansıt (sayfa yenilendiğinde varsayılan değerlerde takılı kalmasın)
updateMaintenancePanel();

// --- BAŞLANGIÇ ŞEHRİ (EVLERİ YERLEŞTİR) ---
function generateInitialCity(skipRecord) {
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
        
        worldGroup.add(houseGroup);
        meshes.push(houseGroup);
        // YENİ: İlk evleri koruma altına almak için isInitial bayrağı eklendi
        if (!skipRecord) structures.push({ type: 'house', zone: 'city', capacity: 1, row: randomTile.row, col: randomTile.col, batteryTarget: '', health: 100, broken: false, isInitial: true });
    }
    if (!skipRecord) state.land.cityUsed += 100; // 20 ev x 5 ha
}

// --- ARAZİ SATIN ALMA (HARİTAYA ZEMİN EKLER) ---
window.buyLand = function() {
    let type = document.getElementById('landBuySelect').value;
    let cost = type === 'city' ? 20000 : (type === 'rural' ? 10000 : 5000);
    
    if (state.budget < cost) { SoundEngine.error(); showAlert("Bu araziyi satın almak için yeterli bütçen yok!"); return; }
    
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
    recenterWorld();
    
    let typeName = type === 'city' ? 'Şehir İçi' : (type === 'rural' ? 'Kırsal Alan' : 'Orman');
    showAlert(`Harika! ${typeName} haritada 50 ha genişledi. Uca eklenen yeni arazilere bakabilirsin!`);
    updateUI();
    saveGame();
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

    // YENİ: Santral türüne göre kapasite faktörü bilgisini belirle
    let cfText = "";
    if (currentPreviewType === 'coal') cfText = "%75 (Sabit Üretim)";
    else if (currentPreviewType === 'gas') cfText = "%63 (Esnek Yük)";
    else if (currentPreviewType === 'geo') cfText = "%83 (Tam Baz Yük)";
    else if (currentPreviewType === 'hydro') cfText = "%46 (Mevsimsel)";
    else if (currentPreviewType === 'solar') cfText = "☀️ Değişken (Gündüz aktif, Gece %0)";
    else if (currentPreviewType === 'wind') cfText = "🌬️ Değişken (%30 ile %75 arası dalgalanır)";
    else if (currentPreviewType === 'battery') cfText = "🔋 Bağlı olduğu kaynağa göre";
    else cfText = "Yok";

    previewBox.innerHTML = `
        <div style="font-size:15px; margin-bottom:5px;"><b>Planlanan:</b> ${plant.icon} ${capText}</div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:5px; font-size:13px;">
            <div><b>Yatırım:</b> <span style="color:#e67e22;">${totalCost.toLocaleString()} 💰</span></div>
            <div><b>Gider:</b> <span style="color:#e74c3c;">-${totalOpex} 💰/döngü</span></div>
            <div><b>Karbon Etkisi:</b> ${emsText}</div>
            <div><b>Arazi:</b> ${totalLand} ha</div>
            ${cfText !== "Yok" ? `<div style="grid-column: span 2; margin-top: 5px; padding-top: 5px; border-top: 1px dashed #bdc3c7;"><b>Kapasite Faktörü:</b> <span style="color:#2980b9;">${cfText}</span></div>` : ""}
        </div>
        ${warningHtml}
    `;
}
// --- YENİ SÖKÜM PANELİ KODLARI ---
function updateDemolishPanel() {
    let container = document.getElementById('demolish-list');
    if (!container) return;
    
    if (structures.length === 0) {
        container.innerHTML = "<div style='font-size: 13px; color: #7f8c8d; padding: 10px; background: #fff; border-radius: 5px;'>Şu an haritada sökülecek tesis yok.</div>";
        return;
    }

    let html = "";
    let visibleCount = 0;

    // Orijinal dizilim sırasını kaybetmemek için index'i kaydederek listeyi ters çeviriyoruz
    let listWithIndex = structures.map((s, index) => ({ s, originalIndex: index })).reverse();

    listWithIndex.forEach(item => {
        let s = item.s;
        let originalIndex = item.originalIndex;

        // 1. KURAL: Ağaçları söküm listesinden tamamen gizle
        if (s.type === 'tree') return; 

        // 2. KURAL: Oyun başındaki ilk 20 evi (ana yerleşkeyi) gizle 
        // (Eski kayıtlı oyunları da kapsasın diye originalIndex < 20 kontrolü de yapıyoruz)
        if (s.type === 'house' && (s.isInitial || originalIndex < 20)) return;

        let plant = plants[s.type];
        let zoneName = s.zone === 'city' ? 'Şehir İçi' : s.zone === 'rural' ? 'Kırsal' : 'Orman';
        let capText = s.type === 'house' ? `${s.capacity} Blok Ev` : `${s.capacity} MW`;
        
        // 3. KURAL: Depolamanın Güneşe mi Rüzgara mı bağlı olduğunu yaz
        if (s.type === 'battery') {
            let targetName = s.batteryTarget === 'solar' ? '☀️ Güneş' : '🌬️ Rüzgar';
            capText += ` (Bağlı: ${targetName})`;
        }
        
       html += `<div style="display:flex; justify-content:space-between; align-items:center; background: #fff; padding: 10px; border: 1px solid #bdc3c7; border-radius: 5px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); gap: 8px; flex-wrap: wrap;">
    <div style="font-size: 14px;"><b>${plant.icon} ${plant.name}</b> <span style="font-size:12px; color:#7f8c8d;">(${capText} - ${zoneName})</span></div>
    <div style="display:flex; gap:6px;">
        <button class="action-btn" style="width: auto; margin: 0; padding: 6px 12px; background:#16a085; color:#fff;" onclick="upgradePlantFromList(${s.row}, ${s.col})">➕ Ekle</button>
        <button class="action-btn demolish" style="width: auto; margin: 0; padding: 6px 12px;" onclick="demolishPlantFromList(${s.row}, ${s.col})">❌ Sök</button>
    </div>
</div>`;
        
        visibleCount++;
    });

    // Eğer tüm filtrelerden sonra listede gösterecek hiçbir şey kalmadıysa boş uyarısı ver
    if (visibleCount === 0) {
        html = "<div style='font-size: 13px; color: #7f8c8d; padding: 10px; background: #fff; border-radius: 5px;'>Şu an sökülebilecek (ağaçlar ve ana evler hariç) bir tesis yok.</div>";
    }

    container.innerHTML = html;
}

window.demolishPlantFromList = function(row, col) {
    let s = structures.find(st => st.row === row && st.col === col);
    if (!s) return;
    let plant = plants[s.type];
    // Ücretsiz söküm onayı
    showConfirm(`🏗️ ${plant.icon} ${plant.name} tesisini haritadan tamamen söküyorsun (Ücretsiz).\n\nOnaylıyor musun?`, function () {
        if (window.SoundEngine) window.SoundEngine.demolish();
        let meshObj = meshes.find(m => m.userData.gridRef && m.userData.gridRef.row === row && m.userData.gridRef.col === col);
        if (meshObj) {
            let d = meshObj.userData;
            state.emissions -= d.ems; 
            state.totalOpex = Math.max(0, state.totalOpex - d.opex);
            
            if (d.type === 'house') { state.installed[d.zone][d.type] -= d.capacity; state.maxPopulation -= (d.capacity * 50); }
            else if (d.type === 'battery') state.installed[d.zone][d.batteryTarget + 'Storage'] -= d.capacity;
            else state.installed[d.zone][d.type] -= d.capacity;
            
            if (d.zone === "city") state.land.cityUsed = Math.max(0, state.land.cityUsed - d.land);
            else if (d.zone === "rural") state.land.ruralUsed = Math.max(0, state.land.ruralUsed - d.land);
            else if (d.zone === "forest") state.land.forestUsed = Math.max(0, state.land.forestUsed - d.land);
            d.gridRef.isOccupied = false; 
            state.plantCounts[d.type] = Math.max(0, (state.plantCounts[d.type] || 0) - 1);
            worldGroup.remove(meshObj);
            meshes = meshes.filter(m => m !== meshObj);
        }
        structures = structures.filter(st => !(st.row === row && st.col === col));
        updateUI();
        saveGame();
    });
};

window.upgradePlantFromList = function(row, col) {
    let meshObj = meshes.find(m => m.userData.gridRef && m.userData.gridRef.row === row && m.userData.gridRef.col === col);
    if (!meshObj) return;
    let d = meshObj.userData;
    let plant = plants[d.type];

    showPrompt(`Kaç birim İLAVE etmek istiyorsunuz? (Birim Fiyat: ${plant.costPerMw} 💰)`, '', function (extraStr) {
        if (!extraStr) return;
        let extraCapacity = parseInt(extraStr);
        if (isNaN(extraCapacity) || extraCapacity <= 0) return;

        let extraCost = extraCapacity * plant.costPerMw;
        let extraLand = extraCapacity * plant.landPerMw;

       if (state.budget < extraCost) { SoundEngine.error(); showAlert("Yetersiz Bütçe!"); return; }
        if (d.zone === "city" && (state.land.cityUsed + extraLand > state.land.cityMax)) { SoundEngine.error(); showAlert("Arazi yetersiz!"); return; }
        if (d.zone === "rural" && (state.land.ruralUsed + extraLand > state.land.ruralMax)) { SoundEngine.error(); showAlert("Arazi yetersiz!"); return; }
        if (d.zone === "forest" && (state.land.forestUsed + extraLand > state.land.forestMax)) { SoundEngine.error(); showAlert("Arazi yetersiz!"); return; }

        // --- YENİ: DEPOLAMA KAPASİTESİ KONTROLÜ ---
        if (d.type === 'battery') {
            let availableUnstored = state.installed[d.zone][d.batteryTarget] - state.installed[d.zone][d.batteryTarget + 'Storage'];
            if (extraCapacity > availableUnstored) {
                if (window.SoundEngine) SoundEngine.error();
                let targetName = d.batteryTarget === 'solar' ? 'Güneş' : 'Rüzgar';
                showAlert(`⚠️ Kapasite Sınırı!\n\nŞu anki boşluk: ${availableUnstored} MW\n\nDaha fazla depolama ekleyebilmek için önce o bölgedeki ${targetName} santrallerinin kapasitesini artırmalısın.`);
                return;
            }
        }
        // ------------------------------------------

        const GEN_TYPES_UP = ['coal', 'gas', 'geo', 'hydro', 'solar', 'wind'];
        if (GEN_TYPES_UP.includes(d.type)) {
            let totalInstalled = 0, totalBaseload = 0;
            GEN_TYPES_UP.forEach(t => {
                let sum = getCapacity(t);
                totalInstalled += sum;
                if (BASELOAD_TYPES.includes(t)) totalBaseload += sum;
            });
            let newTotal = totalInstalled + extraCapacity;
            let newBaseload = totalBaseload + (BASELOAD_TYPES.includes(d.type) ? extraCapacity : 0);
            let ratio = newTotal > 0 ? newBaseload / newTotal : 1;
            if (ratio < BASELOAD_MIN_RATIO - 0.0001) {
                SoundEngine.error();
                showAlert(`⚠️ BAZ YÜK KISITI\n\nKurulu gücün en az %40'ı Kömür, Doğalgaz veya Jeotermal olmak zorunda.\n\nBu eklemeyi yaparsan baz yük oranı %${(ratio * 100).toFixed(1)}'e düşer. İzin verilmiyor.`);
                return;
            }
        }

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

        let structEntry = structures.find(s => s.row === row && s.col === col);
        if (structEntry) structEntry.capacity = d.capacity;

        showAlert(`✅ ${plant.icon} ${plant.name} kapasitesi ${extraCapacity} birim artırıldı!`);
        updateUI();
        saveGame();
    });
};

function updateUI() {

    document.getElementById('cityMaxDisplay').innerText = state.land.cityMax;
    document.getElementById('ruralMaxDisplay').innerText = state.land.ruralMax;
    document.getElementById('forestMaxDisplay').innerText = state.land.forestMax;

    document.getElementById('population').innerText =
        Math.floor(state.population);

    document.getElementById('maxPopDisplay').innerText =
        state.maxPopulation;

    document.getElementById('budget').innerText =
        Math.floor(state.budget);
    
    // YENİ EKLENEN KISIM: Arayüz güncellendiğinde söküm listesini de güncelle
    if (typeof updateDemolishPanel === 'function') updateDemolishPanel();

    // YENİ EKLENEN KISIM: Arayüz güncellendiğinde söküm listesini de güncelle
    if (typeof updateDemolishPanel === 'function') updateDemolishPanel();
    
    // BUNU YENİ EKLİYORUZ: Arıza bildirimlerini güncelle
    if (typeof updateBreakdownAlerts === 'function') updateBreakdownAlerts();
}


function buildPlant(type) {
    let capacity = parseInt(document.getElementById('capacityInput').value);
    let zone = document.getElementById('zoneSelect').value;
    let plant = plants[type];
    
    if (isNaN(capacity) || capacity <= 0) return;
    if (zone === "city" && !plant.allowedInCity) { SoundEngine.error(); showAlert("Halk itirazı! Bu tesis şehir içine kurulamaz."); return; }
    
    if (zone === "forest" && type !== "tree") { SoundEngine.error(); showAlert("Hata: Orman alanına sadece Ağaç dikilebilir!"); return; }
    if (type === "tree" && zone !== "forest") { SoundEngine.error(); showAlert("Hata: Ağaçlar sadece Orman alanına dikilebilir!"); return; }
    if (type === "house" && zone !== "city") { SoundEngine.error(); showAlert("Hata: İnsanlar sadece Şehir İçi alanlara yerleşebilir!"); return; }

    let emptyTile = getNextEmptySlot(zone);
    if (!emptyTile) { SoundEngine.error(); showAlert(`Haritada yer kalmadı! Yukarıdan arazi satın al.`); return; }

    let landToAdd = capacity * plant.landPerMw;
    if (zone === "city" && (state.land.cityUsed + landToAdd > state.land.cityMax)) { SoundEngine.error(); showAlert("Şehirde yeterli arazi kalmadı! Arazi satın alın."); return; }
    if (zone === "rural" && (state.land.ruralUsed + landToAdd > state.land.ruralMax)) { SoundEngine.error(); showAlert("Kırsalda yeterli arazi kalmadı! Arazi satın alın."); return; }
    if (zone === "forest" && (state.land.forestUsed + landToAdd > state.land.forestMax)) { SoundEngine.error(); showAlert("Ormanda yer kalmadı! Arazi satın alın."); return; }

    let totalCost = capacity * plant.costPerMw;
    if (state.budget < totalCost) { SoundEngine.error(); showAlert("Yetersiz Bütçe!"); return; }

    // --- BAZ YÜK KISITI: kurulu gücün en az %40'ı Kömür/Doğalgaz/Jeotermal olmak zorunda ---
    const GEN_TYPES = ['coal', 'gas', 'geo', 'hydro', 'solar', 'wind'];
    if (GEN_TYPES.includes(type)) {
        let totalInstalled = 0, totalBaseload = 0;
        GEN_TYPES.forEach(t => {
            let sum = getCapacity(t);
            totalInstalled += sum;
            if (BASELOAD_TYPES.includes(t)) totalBaseload += sum;
        });
        let newTotal = totalInstalled + capacity;
        let newBaseload = totalBaseload + (BASELOAD_TYPES.includes(type) ? capacity : 0);
        let ratio = newTotal > 0 ? newBaseload / newTotal : 1;
        if (ratio < BASELOAD_MIN_RATIO - 0.0001) {
            SoundEngine.error();
            showAlert(`⚠️ BAZ YÜK KISITI\n\nKurulu gücün en az %40'ı Kömür, Doğalgaz veya Jeotermal olmak zorunda.\n\nBu tesisi kurarsan baz yük oranı %${(ratio * 100).toFixed(1)}'e düşer. İzin verilmiyor - önce baz yük kapasitesi ekle.`);
            return;
        }
    }

    if (type === 'battery') {
        showPrompt("Güneş için 'G', Rüzgar için 'R' yaz:", '', function (answer) {
            if (!answer) return;
            answer = answer.toUpperCase();
            if (answer !== 'G' && answer !== 'R') return;
            let batteryTarget = answer === 'G' ? 'solar' : 'wind';
            let availableUnstored = state.installed[zone][batteryTarget] - state.installed[zone][batteryTarget + 'Storage'];
            if (capacity > availableUnstored) { SoundEngine.error(); showAlert("Yeterli boş tesis yok! Önce o kadar güneş/rüzgar kurulu olması lazım."); return; }
            confirmAndBuild(type, zone, capacity, plant, emptyTile, landToAdd, totalCost, batteryTarget);
        });
        return;
    }

    confirmAndBuild(type, zone, capacity, plant, emptyTile, landToAdd, totalCost, "");
}

function confirmAndBuild(type, zone, capacity, plant, emptyTile, landToAdd, totalCost, batteryTarget) {
    let capText = '';
    if (type === 'tree') capText = `${capacity * 10} Bin Ağaç`;
    else if (type === 'house') capText = `${capacity} Blok Ev (+${capacity * 50} Kapasite)`;
    else capText = `${capacity} MW`;
    let opexToAddPreview = (capacity * plant.opexPerMw).toFixed(2);

    let confirmMsg = `${plant.icon} ${plant.name} KURULUMU\n\n` +
        `Kapasite: ${capText}\n` +
        `Yatırım: ${totalCost.toLocaleString()} 💰\n` +
        `İşletme Gideri: -${opexToAddPreview} 💰/döngü\n` +
        `Arazi Kullanımı: ${landToAdd.toFixed(1)} ha\n` +
        (batteryTarget ? `Bağlanacağı Kaynak: ${batteryTarget === 'solar' ? 'Güneş' : 'Rüzgar'}\n` : '') +
        `\nBu tesisi kurmak istediğine emin misin?`;

    showConfirm(confirmMsg, function () {
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
        state.plantCounts[type] = (state.plantCounts[type] || 0) + 1;
        structures.push({ type: type, zone: zone, capacity: capacity, row: emptyTile.row, col: emptyTile.col, batteryTarget: batteryTarget, health: 100, broken: false });

        createMeshForPlant(type, plant.color, plant.geometry, plant.modelPath, function(mesh) {
            mesh.position.x = emptyTile.col - 9.5; 
            mesh.position.z = emptyTile.row - 9.5;

            mesh.userData = {
                type: type, name: plant.name, icon: plant.icon, zone: zone, color: plant.color,
                capacity: capacity, ems: emissionsToAdd, opex: opexToAdd, land: landToAdd,
                batteryTarget: batteryTarget, gridRef: emptyTile
            };

            worldGroup.add(mesh);
            meshes.push(mesh);
        });
        
        updateUI();
        showAlert(`✅ ${plant.icon} ${plant.name} kuruldu! (${capText})`);
        saveGame();
    });
}

window.triggerUpgrade = function() {
    if(!selectedMesh) return;
    let d = selectedMesh.userData;
    let plant = plants[d.type];
    
    showPrompt(`Kaç birim İLAVE etmek istiyorsunuz? (Birim Fiyat: ${plant.costPerMw} 💰)`, '', function (extraStr) {
        if (!extraStr) return;
        let extraCapacity = parseInt(extraStr);
        if (isNaN(extraCapacity) || extraCapacity <= 0) return;
        
        let extraCost = extraCapacity * plant.costPerMw;
        let extraLand = extraCapacity * plant.landPerMw;
        
        if (state.budget < extraCost) { SoundEngine.error(); showAlert("Yetersiz Bütçe!"); return; }
        if (d.zone === "city" && (state.land.cityUsed + extraLand > state.land.cityMax)) { SoundEngine.error(); showAlert("Arazi yetersiz!"); return; }
        if (d.zone === "rural" && (state.land.ruralUsed + extraLand > state.land.ruralMax)) { SoundEngine.error(); showAlert("Arazi yetersiz!"); return; }
        if (d.zone === "forest" && (state.land.forestUsed + extraLand > state.land.forestMax)) { SoundEngine.error(); showAlert("Arazi yetersiz!"); return; }

        const GEN_TYPES_UP = ['coal', 'gas', 'geo', 'hydro', 'solar', 'wind'];
        if (GEN_TYPES_UP.includes(d.type)) {
            let totalInstalled = 0, totalBaseload = 0;
            GEN_TYPES_UP.forEach(t => {
                let sum = getCapacity(t);
                totalInstalled += sum;
                if (BASELOAD_TYPES.includes(t)) totalBaseload += sum;
            });
            let newTotal = totalInstalled + extraCapacity;
            let newBaseload = totalBaseload + (BASELOAD_TYPES.includes(d.type) ? extraCapacity : 0);
            let ratio = newTotal > 0 ? newBaseload / newTotal : 1;
            if (ratio < BASELOAD_MIN_RATIO - 0.0001) {
                SoundEngine.error();
                showAlert(`⚠️ BAZ YÜK KISITI\n\nKurulu gücün en az %40'ı Kömür, Doğalgaz veya Jeotermal olmak zorunda.\n\nBu yükseltmeyi yaparsan baz yük oranı %${(ratio * 100).toFixed(1)}'e düşer. İzin verilmiyor.`);
                return;
            }
        }
        
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
        
        let structEntry = structures.find(s => s.row === d.gridRef.row && s.col === d.gridRef.col);
        if (structEntry) structEntry.capacity = d.capacity;
        
        selectedMesh.scale.y += 0.2; selectedMesh.position.y += 0.1;
        closeActionMenu();
        updateUI();
        saveGame();
    });
};

window.triggerDemolish = function() {
    if(!selectedMesh) return;
    let d = selectedMesh.userData;
    let plant = plants[d.type]; // Tesisin birim maliyetini almak için
    
    // YENİ: Söküm maliyetini hesapla (Kapasite * Birim Maliyet * %10)
    let demolishCost = (d.capacity * plant.costPerMw) * 0.10;

    showConfirm(`🏗️ ${d.icon} ${plant.name} tesisini sökmek üzeresin.\n\nSöküm Maliyeti: ${demolishCost.toLocaleString()} 💰\n\nOnaylıyor musun?`, function () {
        
        // YENİ: Bütçe kontrolü (Sökmek için de paraya ihtiyaç var)
        if (state.budget < demolishCost) {
            if (window.SoundEngine) window.SoundEngine.error();
            showAlert(`Yetersiz Bütçe!\nBu tesisi sökmek için ${demolishCost.toLocaleString()} 💰 ödemen gerekiyor.`);
            return;
        }

        // Söküm maliyetini kasadan düş
        state.budget -= demolishCost;
        if (window.SoundEngine) window.SoundEngine.demolish();

        // Sistemden tamamen çıkartma işlemleri
        state.emissions -= d.ems; 
        state.totalOpex = Math.max(0, state.totalOpex - d.opex);
        
        if (d.type === 'house') { state.installed[d.zone][d.type] -= d.capacity; state.maxPopulation -= (d.capacity * 50); }
        else if (d.type === 'battery') state.installed[d.zone][d.batteryTarget + 'Storage'] -= d.capacity;
        else state.installed[d.zone][d.type] -= d.capacity;
        
        if (d.zone === "city") state.land.cityUsed = Math.max(0, state.land.cityUsed - d.land);
        else if (d.zone === "rural") state.land.ruralUsed = Math.max(0, state.land.ruralUsed - d.land);
        else if (d.zone === "forest") state.land.forestUsed = Math.max(0, state.land.forestUsed - d.land);

        d.gridRef.isOccupied = false; // Zemini boşalt
        state.plantCounts[d.type] = Math.max(0, (state.plantCounts[d.type] || 0) - 1);
        structures = structures.filter(s => !(s.row === d.gridRef.row && s.col === d.gridRef.col));
        worldGroup.remove(selectedMesh);
        meshes = meshes.filter(m => m !== selectedMesh);
        closeActionMenu();
        updateUI();
        saveGame();
    });
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
    let add = Math.floor(Math.random() * 3 + 1) * 5; // 5-15 birim arası ekle
    let target = current + add;
    let names = {solar: 'Güneş (MW)', wind: 'Rüzgar (MW)', battery: 'Depolama (MW)', tree: 'Ağaç (Birim)', house: 'Ev (Blok)'};
    
    // YENİ: isCompleted: false eklendi
    return { type: t, target: target, reward: add * 100, desc: `${names[t]} kapasiteni ${target} yap`, isCompleted: false };
}

// Oyuna başlarken 3 görev oluştur
dailyGoals = [generateDailyGoal(), generateDailyGoal(), generateDailyGoal()];

function checkGoals() {
    // 1200 döngüde bir (yaklaşık 1 gün) tüm günlük görevleri yenile
    state.dailyGoalTicks = (state.dailyGoalTicks || 0) + 1;
    if (state.dailyGoalTicks >= 1200) {
        dailyGoals = [generateDailyGoal(), generateDailyGoal(), generateDailyGoal()];
        state.dailyGoalTicks = 0;
        if (!simulatingOffline) showAlert("📅 Yeni bir gün başladı! Günlük görevler yenilendi.");
    }

    let container = document.getElementById('daily-goals-container');
    let html = "";
    
    dailyGoals.forEach((goal, index) => {
        // YENİ: Eğer görev henüz tamamlanmadıysa kontrol et
        if (!goal.isCompleted) {
            goal.current = getCapacity(goal.type);
            
            if (goal.current >= goal.target) {
                goal.isCompleted = true; // Görevi "Tamamlandı" olarak işaretle
                state.budget += goal.reward;
                if (!simulatingOffline) {
                    SoundEngine.goal();
                    showAlert(`🎉 GÜNLÜK GÖREV BAŞARILI: ${goal.desc}! \nKasa: +${goal.reward.toLocaleString()} 💰`);
                }
                // DİKKAT: Eski kodda burada görev hemen yenileniyordu (dailyGoals[index] = generateDailyGoal()), o satırı sildik.
            }
        }
        
        // YENİ: Ekrana yazdırma kısmı (Tamamlananlar yeşil tikli görünür)
        if (goal.isCompleted) {
            html += `<div class="goal-item" style="background:#eafaf1; border-color:#27ae60; color:#27ae60; text-align: center;">
                ✅ <del>${goal.desc}</del><br>
                <b>Tamamlandı! (+${goal.reward.toLocaleString()} 💰)</b>
            </div>`;
        } else {
            html += `<div class="goal-item">📌 ${goal.desc}<br>Durum: ${goal.current} / ${goal.target} <br><span style="color:#27ae60;">Ödül: ${goal.reward.toLocaleString()} 💰</span></div>`;
        }
    });
    
    container.innerHTML = html;

    // Genel Görev Kontrolü (Burası aynı kalıyor)
    generalGoal.current = state.population;
    if (generalGoal.current >= generalGoal.target) {
        state.budget += generalGoal.reward;
        if (!simulatingOffline) {
            SoundEngine.goal();
            showAlert(`🏆 GENEL GÖREV BAŞARILI: ${generalGoal.desc}! \nKasa: +${generalGoal.reward.toLocaleString()} 💰`);
        }
        let newTarget = generalGoal.target + 500;
        generalGoal = { type: 'pop', target: newTarget, current: state.population, reward: 10000, desc: `Şehir nüfusunu ${newTarget}'e ulaştır` };
    }
    document.getElementById('generalGoalText').innerHTML = `🌟 <b>Genel Görev:</b> ${generalGoal.desc} <br> Durum: ${generalGoal.current} / ${generalGoal.target} Kişi <br><span style="color:#27ae60;">Ödül: ${generalGoal.reward.toLocaleString()} 💰</span>`;
}
// --- DÖNGÜ VE EFEKTLER ---
function runTick() {
    // GÜNLÜK GİRİŞ ÖDÜLÜ (1200 döngüde bir, birikmeden sadece 1 kez verilir)
    state.loginRewardTicks = (state.loginRewardTicks || 0) + 1;
    if (state.loginRewardTicks >= 1200) {
        state.loginRewardTicks = 0;
        if (!simulatingOffline || !dailyLoginRewardGrantedDuringCatchup) {
            state.budget += 1000;
            if (simulatingOffline) dailyLoginRewardGrantedDuringCatchup = true;
            if (!simulatingOffline) {
                SoundEngine.goal();
                showAlert(`🎁 GÜNLÜK GİRİŞ ÖDÜLÜ!\n\nBugün oyuna girdiğin için +1.000 💰 kazandın!`);
            }
        }
    }

    state.hour++;
    if (state.hour > 23) state.hour = 0;
    state.isDay = (state.hour >= 7 && state.hour < 18);

    // Güneş gün boyu değişir (gece 0), rüzgar ise "hava durumu" gibi zaman zaman rastgele değişir
    state.solarFactor = getSolarFactor(state.hour);
    if (Math.random() > 0.75) state.windFactor = 0.30 + Math.random() * 0.45; // %30 - %75 arası dalgalanan rüzgar

    if (!simulatingOffline) {
        meshes.forEach(m => { if (m.userData && m.userData.isWind && m.userData.blade) { m.userData.blade.rotation.z += (0.15 + state.windFactor * 0.6); } });

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
    }

    // --- SANTRAL SAĞLIĞI: tablo değerleri YÜZDE (örn. 0.10 = %10), bu kayıp 1200 döngüye yayılır ---
    // (Önceki sürümde ham puan olarak uygulanıyordu; kömür günde 0.10 PUAN kaybediyordu, bu da 1000 günde bile
    // fark edilmiyordu. Artık 1200 döngüde (yaklaşık 50 gerçek dakika) o yüzdelik kayıp gerçekleşiyor.)
    structures.forEach(s => {
        let decayPercent = HEALTH_DECAY_PER_1200[s.type];
        if (!decayPercent) return; // ev/ağaç gibi ömrü olmayan yapılar etkilenmez
        if (s.health === undefined || s.health === null) s.health = 100;
        if (s.health > 0) s.health = Math.max(0, s.health - (decayPercent * 100 / 1200));
    });

    // --- ARIZA: ortalama her 1200 döngüde rastgele bir santral arıza verir, üretimi tamamen durur ---
    if (Math.random() < BREAKDOWN_CHANCE_PER_TICK) {
        let eligible = structures.filter(s => HEALTH_DECAY_PER_1200[s.type] !== undefined && !s.broken && s.health >= 10);
        if (eligible.length > 0) {
            let picked = eligible[Math.floor(Math.random() * eligible.length)];
            picked.broken = true;
            picked.alertDismissed = false; // Yeni arıza olduğu için bildirim tekrar aktif edilir
            if (!simulatingOffline) {
                if (window.SoundEngine) SoundEngine.error();
                updateBreakdownAlerts(); // Sağ üstteki dinamik paneli ekrana getir
            }
        }
    }

    // --- HAM ÜRETİM: her tesisin GÜNCEL SAĞLIĞI (ve arıza durumu) ile orantılı kapasitesi üzerinden hesaplanır ---
    function aggregateByZoneType() {
        let agg = {
            city: { coal: 0, gas: 0, geo: 0, hydro: 0, solar: 0, wind: 0, solarBatteryCap: 0, windBatteryCap: 0 },
            rural: { coal: 0, gas: 0, geo: 0, hydro: 0, solar: 0, wind: 0, solarBatteryCap: 0, windBatteryCap: 0 },
            forest: { coal: 0, gas: 0, geo: 0, hydro: 0, solar: 0, wind: 0, solarBatteryCap: 0, windBatteryCap: 0 }
        };
        structures.forEach(s => {
            if (!agg[s.zone]) return;
            if (s.broken) return; // arızalı tesis hiç üretmez / depolamaz
            let health = (s.health === undefined || s.health === null) ? 100 : s.health;
            if (health < 10) return; // sağlık %10 altına düşen tesis kapanır
            if (s.type === 'battery') {
                if (s.batteryTarget === 'wind') agg[s.zone].windBatteryCap += s.capacity * (health / 100);
                else agg[s.zone].solarBatteryCap += s.capacity * (health / 100);
                return;
            }
            if (!(s.type in agg[s.zone])) return; // ev/ağaç vb. üretime dahil değil
            agg[s.zone][s.type] += s.capacity * (health / 100);
        });
        return agg;
    }
    let agg = aggregateByZoneType();

    let coalProd = agg.city.coal * CAPACITY_FACTOR.coal + agg.rural.coal * CAPACITY_FACTOR.coal * 0.9;
    let gasProd = agg.city.gas * CAPACITY_FACTOR.gas + agg.rural.gas * CAPACITY_FACTOR.gas * 0.9;
    let geoProd = agg.city.geo * CAPACITY_FACTOR.geo + agg.rural.geo * CAPACITY_FACTOR.geo * 0.9;
    let hydroProd = agg.city.hydro * CAPACITY_FACTOR.hydro + agg.rural.hydro * CAPACITY_FACTOR.hydro * 0.9;
    let solarProd = agg.city.solar * state.solarFactor + agg.rural.solar * state.solarFactor * 0.9;
    let windProd = agg.city.wind * state.windFactor + agg.rural.wind * state.windFactor * 0.9;

    let totalRawProduction = coalProd + gasProd + geoProd + hydroProd + solarProd + windProd;
    let currentDemandPerPerson = getCurrentDemandPerPerson();
    let currentDemand = state.population * currentDemandPerPerson; // MWh

    // --- DEPOLAMA: SADECE bağlı olduğu kaynağın (güneş/rüzgar) o anki fazla üretimi depolanabilir ---
    // Önce baz/sabit kaynaklar talebi karşılar; güneş+rüzgarın talebi aştığı kısım "yenilenebilir fazlası" sayılır,
    // bu fazla da güneş/rüzgarın o anki üretimindeki payına göre ikiye bölünür.
    let totalSolarBatteryCap = agg.city.solarBatteryCap + agg.rural.solarBatteryCap + agg.forest.solarBatteryCap;
    let totalWindBatteryCap = agg.city.windBatteryCap + agg.rural.windBatteryCap + agg.forest.windBatteryCap;
    let totalMaxStorage = totalSolarBatteryCap + totalWindBatteryCap;

    if (state.solarStorageCharge === undefined) state.solarStorageCharge = 0;
    if (state.windStorageCharge === undefined) state.windStorageCharge = 0;
    state.solarStorageCharge = Math.min(state.solarStorageCharge, totalSolarBatteryCap);
    state.windStorageCharge = Math.min(state.windStorageCharge, totalWindBatteryCap);

    let otherProd = coalProd + gasProd + geoProd + hydroProd;
    let renewableProd = solarProd + windProd;
    let neededFromRenewable = Math.max(0, currentDemand - otherProd);
    let renewableSurplus = Math.max(0, renewableProd - neededFromRenewable);

    let solarSurplus = 0, windSurplus = 0;
    if (renewableSurplus > 0 && renewableProd > 0) {
        solarSurplus = renewableSurplus * (solarProd / renewableProd);
        windSurplus = renewableSurplus * (windProd / renewableProd);
    }

    let solarStored = Math.max(0, Math.min(solarSurplus, totalSolarBatteryCap - state.solarStorageCharge));
    let windStored = Math.max(0, Math.min(windSurplus, totalWindBatteryCap - state.windStorageCharge));
    state.solarStorageCharge += solarStored;
    state.windStorageCharge += windStored;
    let storedThisTick = solarStored + windStored;

    let totalNetProduction = totalRawProduction - storedThisTick;
    let dischargedThisTick = 0;
    let storageMsg = null;

    if (storedThisTick > 0.01) {
        let parts = [];
        if (solarStored > 0.01) parts.push(`☀️ +${solarStored.toFixed(1)} MWh (${state.solarStorageCharge.toFixed(1)}/${totalSolarBatteryCap.toFixed(1)})`);
        if (windStored > 0.01) parts.push(`🌬️ +${windStored.toFixed(1)} MWh (${state.windStorageCharge.toFixed(1)}/${totalWindBatteryCap.toFixed(1)})`);
        storageMsg = { type: 'charge', text: `🔋 Depolama yapılıyor: ${parts.join(' | ')}` };
    }

    let netBeforeDischarge = totalNetProduction - currentDemand;
    if (netBeforeDischarge < 0) {
        let deficit = -netBeforeDischarge;
        let availableCombined = state.solarStorageCharge + state.windStorageCharge;
        dischargedThisTick = Math.max(0, Math.min(deficit, availableCombined));
        if (dischargedThisTick > 0.01) {
            let fromSolar = availableCombined > 0 ? dischargedThisTick * (state.solarStorageCharge / availableCombined) : 0;
            let fromWind = dischargedThisTick - fromSolar;
            state.solarStorageCharge = Math.max(0, state.solarStorageCharge - fromSolar);
            state.windStorageCharge = Math.max(0, state.windStorageCharge - fromWind);
            totalNetProduction += dischargedThisTick;
            storageMsg = { type: 'discharge', text: `🔋 Depolamadan kullanılıyor: -${dischargedThisTick.toFixed(1)} MWh (Kalan: ${(state.solarStorageCharge + state.windStorageCharge).toFixed(1)}/${totalMaxStorage.toFixed(1)} MWh)` };
        }
    }


    let soldEnergy = Math.min(totalNetProduction, currentDemand);
    let wastedEnergy = Math.max(0, totalNetProduction - currentDemand);
    let netEnergy = totalNetProduction - currentDemand;
    const BALANCE_TOLERANCE = 0.5; // MWh - bu aralıktaki fark "denge" sayılır, açık/kesinti değil

    let currentPrice = getCurrentPrice();
    let income = soldEnergy * currentPrice;
    let expense = state.totalOpex;
    let displayEms = Math.max(0, state.emissions); 
    let carbonTax = displayEms > 30 ? (displayEms - 30) * 2.5 : 0; 
    
    // YENİ: Fazla üretim cezası 10 olarak güncellendi
    const OVERPRODUCTION_PENALTY_PER_MWH = 4.0; 
    let overproductionCost = wastedEnergy * OVERPRODUCTION_PENALTY_PER_MWH;

    // YENİ: Eksik üretim (şebekeye verilemeyen) hesaplaması ve cezası
    let deficitEnergy = Math.max(0, currentDemand - totalNetProduction);
    const UNDERPRODUCTION_PENALTY_PER_MWH = 10.0; 
    let underproductionCost = deficitEnergy * UNDERPRODUCTION_PENALTY_PER_MWH;

    // BÜTÇE GÜNCELLEMESİ
    state.budget += (income - expense - carbonTax - overproductionCost - underproductionCost);

    // --- YENİ: İFLAS KONTROLÜ (GAME OVER) ---
    if (state.budget <= 0) {
        state.budget = 0;
        document.getElementById('budget').innerText = "0"; // Ekranda 0 göster
        clearInterval(gameLoop); // Zamanın akmasını (oyunu) durdur
        if (window.SoundEngine) window.SoundEngine.error(); // Hata sesi çal
        
        // İflas penceresi çıkar ve onaylanınca oyunu sıfırla
        showConfirm(
            "💀 İFLAS ETTİN!\n\nKasan tamamen sıfırlandı, borçlarını ödeyemedin ve enerji ağı çöktü. Şehir maalesef karanlığa gömüldü.\n\nHatalarından ders çıkarıp baştan başlamak ister misin?", 
            function() {
                resetGame(); // Oyunu sil ve baştan başlat
            }
        );
        return; // Aşağıdaki kodların çalışmasını engelle ve döngüden çık
    }

    // NÜFUS ARTIŞI (tolerans payı içinde kalan fark "denge" sayılır, kesinti tetiklemez)
    if (netEnergy >= -BALANCE_TOLERANCE && state.population < state.maxPopulation) state.population += 1;
    else if (netEnergy < -BALANCE_TOLERANCE) state.population -= 1;

    // Nüfus, mevcut kapasiteyi (maxPopulation) hiçbir durumda aşamaz
    state.population = Math.max(0, Math.min(state.population, state.maxPopulation));

    // --- YENİ: NÜFUS GÖÇÜ KONTROLÜ (GAME OVER) ---
    if (state.population <= 0) {
        state.population = 0;
        document.getElementById('population').innerText = "0"; // Ekranda 0 göster
        clearInterval(gameLoop); // Zamanın akmasını (oyunu) durdur
        if (window.SoundEngine) window.SoundEngine.error(); // Hata sesi çal
        
        // Nüfus göçü penceresi çıkar ve onaylanınca oyunu sıfırla
        showConfirm(
            "👻 ŞEHİR TERK EDİLDİ!\n\nSürekli yaşanan elektrik kesintileri yüzünden halk tamamen göç etti ve VoltCity bir hayalet şehre dönüştü. Oyunu kaybettin.\n\nYeni bir enerji politikasıyla sıfırdan başlamak ister misin?", 
            function() {
                resetGame(); // Oyunu sil ve baştan başlat
            }
        );
        return; // Aşağıdaki kodların çalışmasını engelle ve döngüden çık
    }

    if (!simulatingOffline) {
        document.getElementById('budget').innerText = Math.floor(state.budget).toLocaleString();
        document.getElementById('emissions').innerText = displayEms.toFixed(1);
        
        document.getElementById('population').innerText = Math.floor(state.population);
        document.getElementById('demand').innerText = currentDemand.toFixed(1);
        
        document.getElementById('energy').innerText = totalNetProduction.toFixed(1);
        document.getElementById('soldEnergy').innerText = soldEnergy.toFixed(1);
        
        document.getElementById('cityLand').innerText = Math.floor(state.land.cityUsed);
        document.getElementById('ruralLand').innerText = Math.floor(state.land.ruralUsed);
        document.getElementById('forestLand').innerText = Math.floor(state.land.forestUsed);
        
        let breakdownHtml = `<span style="color:#2ecc71;">+${income.toFixed(1)} 💰 Gelir</span> | <span style="color:#e74c3c;">-${expense.toFixed(1)} 💰 Gider</span>`;
        if (carbonTax > 0) breakdownHtml += ` | <span class="tax-alert">-${carbonTax.toFixed(1)} 💰 Vergi</span>`;
        if (overproductionCost > 0) breakdownHtml += ` | <span style="color:#d35400;">-${overproductionCost.toFixed(1)} 💰 İsraf Cezası</span>`;
        
        // YENİ: Kesinti/Eksik üretim cezasını ekrana yansıt
        if (underproductionCost > 0) breakdownHtml += ` | <span style="color:#c0392b;">-${underproductionCost.toFixed(1)} 💰 Kesinti Cezası</span>`;
        
        breakdownHtml += ` | <span style="color:#f1c40f;">Fiyat: ${currentPrice.toFixed(1)} 💰/MWh</span>`;
        document.getElementById('budgetBreakdown').innerHTML = breakdownHtml;

        let bdHtml = "";
        if(coalProd > 0) bdHtml += `<div class="income-row"><span>🏭 Kömür:</span> <span>${coalProd.toFixed(1)} MWh</span></div>`;
        if(gasProd > 0) bdHtml += `<div class="income-row"><span>🔥 Doğalgaz:</span> <span>${gasProd.toFixed(1)} MWh</span></div>`;
        if(solarProd > 0) bdHtml += `<div class="income-row"><span>☀️ Güneş:</span> <span>${solarProd.toFixed(1)} MWh</span></div>`;
        if(windProd > 0) bdHtml += `<div class="income-row"><span>🌬️ Rüzgar:</span> <span>${windProd.toFixed(1)} MWh</span></div>`;
        if(geoProd + hydroProd > 0) bdHtml += `<div class="income-row"><span>🌋/🌊 Jeo/Hidro:</span> <span>${(geoProd+hydroProd).toFixed(1)} MWh</span></div>`;
        if (storedThisTick > 0.01) bdHtml += `<div class="income-row"><span style="color:#8e44ad;">🔋 Depoya Giden:</span> <span style="color:#8e44ad;">-${storedThisTick.toFixed(1)} MWh</span></div>`;
        if (dischargedThisTick > 0.01) bdHtml += `<div class="income-row"><span style="color:#2ecc71;">🔋 Depodan Gelen:</span> <span style="color:#2ecc71;">+${dischargedThisTick.toFixed(1)} MWh</span></div>`;
        
        document.getElementById('breakdownDetails').innerHTML = bdHtml || "Henüz üretim yapan santral yok.";

        document.getElementById('clockDisplay').innerText = (state.isDay ? "🌞 " : "🌙 ") + (state.hour < 10 ? "0" : "") + state.hour + ":00";
        document.getElementById('solarDisplay').innerText = `Güneş: %${Math.floor(state.solarFactor * 100)}`;
        document.getElementById('windDisplay').innerText = `Rüzgar: %${Math.floor(state.windFactor * 100)}`;

        // --- KURULU GÜÇ PANELİ ---
        document.getElementById('installedTotal').innerText = getCapacity('coal') + getCapacity('gas') + getCapacity('geo') + getCapacity('hydro') + getCapacity('solar') + getCapacity('wind');
        let genList = [
            { key: 'coal', icon: '🏭', name: 'Kömür' }, { key: 'gas', icon: '🔥', name: 'Doğalgaz' },
            { key: 'solar', icon: '☀️', name: 'Güneş' }, { key: 'wind', icon: '🌬️', name: 'Rüzgar' },
            { key: 'geo', icon: '🌋', name: 'Jeotermal' }, { key: 'hydro', icon: '🌊', name: 'Hidrolik' }
        ];
        let instHtml = "";
        genList.forEach(p => {
            let count = state.plantCounts[p.key] || 0;
            if (count > 0) instHtml += `<div class="income-row"><span>${p.icon} ${p.name}:</span> <span>${count} adet, ${getCapacity(p.key).toFixed(0)} MW</span></div>`;
        });
        let batCount = state.plantCounts.battery || 0;
        if (batCount > 0) instHtml += `<div class="income-row"><span>🔋 Depolama:</span> <span>${batCount} adet, ${totalMaxStorage.toFixed(0)} MW kapasite</span></div>`;
        let treeCount = state.plantCounts.tree || 0;
        if (treeCount > 0) instHtml += `<div class="income-row"><span>🌳 Ağaç:</span> <span>${treeCount} adet, ${(getCapacity('tree')*10).toFixed(0)} Bin Ağaç</span></div>`;
        let houseCount = state.plantCounts.house || 0;
        if (houseCount > 0) instHtml += `<div class="income-row"><span>🏠 Ev:</span> <span>${houseCount} adet, ${getCapacity('house')} Blok</span></div>`;
        document.getElementById('installedDetails').innerHTML = instHtml || "Henüz tesis kurulmadı.";
        updateMaintenancePanel();

        // --- DEPOLAMA DURUM SATIRI ---
        let storageStatusDiv = document.getElementById('storage-status');
        if (totalMaxStorage > 0) {
            storageStatusDiv.style.display = 'block';
            if (storageMsg) {
                storageStatusDiv.innerHTML = storageMsg.text;
                storageStatusDiv.style.color = storageMsg.type === 'charge' ? '#8e44ad' : '#d35400';
            } else {
                storageStatusDiv.innerHTML = `🔋 Depo Durumu: ${(state.solarStorageCharge + state.windStorageCharge).toFixed(1)} / ${totalMaxStorage.toFixed(1)} MWh (beklemede)`;
                storageStatusDiv.style.color = '#7f8c8d';
            }
        } else {
            storageStatusDiv.style.display = 'none';
        }
        
        let advisorDiv = document.getElementById('advisor-message');
        let currentAdvisorState = 'warning';
        if (displayEms > 30) {
            advisorDiv.innerHTML = `🚨 DANIŞMAN: Bütçen karbon vergisinden eriyor (-${carbonTax.toFixed(1)} 💰). Fosil yakıtları sök veya acilen <b>Ağaç Dik</b>!`;
            advisorDiv.className = "danger-advisor";
            currentAdvisorState = 'danger';
        } else if (netEnergy < -BALANCE_TOLERANCE && dischargedThisTick <= 0.01) {
            advisorDiv.innerHTML = `🚨 DANIŞMAN: Elektrik yetersiz! Şebeke çöküyor, nüfus azalıyor. Hemen yatırım yap veya <b>Depolama</b> kur!`;
            advisorDiv.className = "danger-advisor";
            currentAdvisorState = 'danger';
        } else if (netEnergy < -BALANCE_TOLERANCE && dischargedThisTick > 0.01) {
            advisorDiv.innerHTML = `⚠️ DANIŞMAN: Üretim yetersiz ama depodan destek alınıyor (-${dischargedThisTick.toFixed(1)} MWh). Depo tükenmeden yeni kapasite ekle!`;
            advisorDiv.className = "warning-advisor";
            currentAdvisorState = 'warning';
        } else if (state.population >= state.maxPopulation && totalNetProduction >= currentDemand) {
            advisorDiv.innerHTML = `⚠️ DANIŞMAN: Şehirde boş ev kalmadı! Nüfusun artması için yeni <b>Ev Kur</b> veya <b>Arazi Satın Al</b>.`;
            advisorDiv.className = "warning-advisor";
            currentAdvisorState = 'warning';
        } else if (wastedEnergy > 20) {
            advisorDiv.innerHTML = `⚠️ DANIŞMAN: ${wastedEnergy.toFixed(1)} MWh israf var, bu sana saatte ${(wastedEnergy * OVERPRODUCTION_PENALTY_PER_MWH).toFixed(1)} 💰 fazladan gidere mal oluyor! Tesis sök ya da Depolama kur.`;
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
    }

    checkGoals();
    saveGame();
}

// Döngüyü durdurabilmek için ona bir isim (gameLoop) veriyoruz
gameLoop = setInterval(runTick, 5000);
