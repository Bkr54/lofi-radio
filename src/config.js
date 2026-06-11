const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '../config/stream.json');

// Valeurs non sensibles uniquement. Les secrets (streamKey, password) viennent de l'environnement (.env).
const defaultConfig = {
  port: parseInt(process.env.PORT, 10) || 8080,
  streamUrl: process.env.STREAM_URL || 'rtmp://a.rtmp.youtube.com/live2',
  videoBitrate: '2500k',
  audioBitrate: '128k',
  resolution: '1920x1080',
  fps: 30
};

function loadConfig() {
  let cfg = { ...defaultConfig };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      const onDisk = JSON.parse(data);
      // On ignore volontairement streamKey/password du JSON : ils sont gérés via .env
      delete onDisk.streamKey;
      delete onDisk.password;
      cfg = { ...cfg, ...onDisk };
    }
  } catch (err) {
    console.error('Erreur chargement config:', err);
  }
  // Secrets injectés depuis l'environnement
  cfg.streamKey = process.env.STREAM_KEY || '';
  cfg.passwordHash = process.env.DASHBOARD_PASSWORD_HASH || '';
  return cfg;
}

function saveConfig(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    // Ne jamais réécrire les secrets dans le JSON
    const { streamKey, password, passwordHash, ...safe } = config;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(safe, null, 2));
    return true;
  } catch (err) {
    console.error('Erreur sauvegarde config:', err);
    return false;
  }
}

module.exports = {
  defaultConfig,
  loadConfig,
  saveConfig,
  CONFIG_PATH
};
