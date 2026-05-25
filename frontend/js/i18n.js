/**
 * i18n - Multi-language support
 */
const LANG = {
  en: {
    title: '✈️ Flight Radar',
    aircraft: 'Aircraft',
    filter: '🔍 Filter',
    filterPlaceholder: 'Callsign, route (e.g. PEK-SHA), type',
    clear: 'Clear',
    altitude: 'Altitude',
    legendGround: 'Ground',
    legendLow: '< 5,000 ft',
    legendMid: '5,000–25,000 ft',
    legendHigh: '25,000–35,000 ft',
    legendCruise: '> 35,000 ft',
    icao: 'ICAO',
    type: 'Type',
    reg: 'Reg',
    country: 'Country',
    speed: 'Speed',
    heading: 'Heading',
    vs: 'V/S',
    squawk: 'Squawk',
    route: 'Route',
    tracked: 'tracked',
    inView: 'in view',
    avgAlt: 'Avg alt',
    showing: 'Showing',
    of: 'of',
    connecting: 'Connecting...',
    live: 'Live',
    reconnecting: 'Reconnecting...'
  },
  zh: {
    title: '✈️ 航班雷达',
    aircraft: '航班',
    filter: '🔍 筛选',
    filterPlaceholder: '航班号、航线 (如 PEK-SHA)、机型',
    clear: '清除',
    altitude: '高度',
    legendGround: '地面',
    legendLow: '< 1,500 米',
    legendMid: '1,500–7,600 米',
    legendHigh: '7,600–10,700 米',
    legendCruise: '> 10,700 米',
    icao: 'ICAO',
    type: '机型',
    reg: '注册号',
    country: '国家',
    speed: '速度',
    heading: '航向',
    vs: '升降率',
    squawk: '应答码',
    route: '航线',
    tracked: '追踪中',
    inView: '可见',
    avgAlt: '平均高度',
    showing: '显示',
    of: '/',
    connecting: '连接中...',
    live: '实时',
    reconnecting: '重连中...'
  },
  ja: {
    title: '✈️ フライトレーダー',
    aircraft: '航空機',
    filter: '🔍 フィルター',
    filterPlaceholder: 'コールサイン、路線、機種',
    clear: 'クリア',
    altitude: '高度',
    legendGround: '地上',
    legendLow: '< 1,500 m',
    legendMid: '1,500–7,600 m',
    legendHigh: '7,600–10,700 m',
    legendCruise: '> 10,700 m',
    icao: 'ICAO',
    type: '機種',
    reg: '登録番号',
    country: '国',
    speed: '速度',
    heading: '方位',
    vs: '昇降率',
    squawk: 'スコーク',
    route: '路線',
    tracked: '追跡中',
    inView: '表示中',
    avgAlt: '平均高度',
    showing: '表示',
    of: '/',
    connecting: '接続中...',
    live: 'ライブ',
    reconnecting: '再接続中...'
  }
};

const LANG_LABELS = {
  en: 'English',
  zh: '中文',
  ja: '日本語'
};

// --- Theme ---
const THEMES = {
  dark: {
    tiles: [
      'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
    ],
    bodyClass: '',
    label: { en: '🌙', zh: '🌙', ja: '🌙' }
  },
  light: {
    tiles: [
      'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'
    ],
    bodyClass: 'theme-light',
    label: { en: '☀️', zh: '☀️', ja: '☀️' }
  }
};

let currentTheme = localStorage.getItem('flightradar-theme') || 'dark';

function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('flightradar-theme', currentTheme);
  applyTheme();
}

function applyTheme() {
  const theme = THEMES[currentTheme];
  document.body.className = theme.bodyClass;
  document.getElementById('theme-btn').textContent = currentTheme === 'dark' ? '☀️' : '🌙';

  // Update map tiles if map is ready
  if (typeof map !== 'undefined' && map.getSource && map.getSource('carto-dark')) {
    map.getSource('carto-dark').setTiles(theme.tiles);
  }
}

let currentLang = localStorage.getItem('flightradar-lang') || 'en';

function t(key) {
  return LANG[currentLang]?.[key] || LANG.en[key] || key;
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem('flightradar-lang', lang);
  updateUI();
  // Close dropdown
  document.getElementById('lang-dropdown').classList.remove('open');
}

function toggleLangDropdown() {
  document.getElementById('lang-dropdown').classList.toggle('open');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('#lang-toggle')) {
    document.getElementById('lang-dropdown').classList.remove('open');
  }
});

function updateUI() {
  document.getElementById('info-title').textContent = t('title');
  document.getElementById('label-aircraft').textContent = t('aircraft');
  document.getElementById('filter-toggle').querySelector('span').textContent = t('filter');
  document.getElementById('filter-input').placeholder = t('filterPlaceholder');
  document.getElementById('btn-clear').textContent = t('clear');
  document.getElementById('legend-title').textContent = t('altitude');
  document.getElementById('legend-ground').textContent = t('legendGround');
  document.getElementById('legend-low').textContent = t('legendLow');
  document.getElementById('legend-mid').textContent = t('legendMid');
  document.getElementById('legend-high').textContent = t('legendHigh');
  document.getElementById('legend-cruise').textContent = t('legendCruise');
  document.getElementById('lang-current').textContent = LANG_LABELS[currentLang];

  // Detail labels
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });

  // Refresh stats
  if (typeof updateStatsBar === 'function') updateStatsBar();

  // Apply theme
  applyTheme();
}
