// ============================================================
//  POST/GET /api/reset-counter?token=XXXX   (MANTENIMIENTO)
//  Reinicia el contador de piezas a 0 y borra los registros de
//  asignacion de las pruebas. Protegido por un token secreto:
//  sin el token exacto (env ADMIN_RESET_TOKEN) responde 403 y no hace nada.
//
//  Uso previsto: una sola vez, justo antes del lanzamiento publico,
//  para que el primer donante real sea el Nº 1. Despues se puede borrar.
// ============================================================
function kvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function kv(command) {
  const { url, token } = kvConfig();
  if (!url || !token) throw new Error('Almacen KV no configurado.');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await resp.json();
  if (data.error) throw new Error('KV: ' + data.error);
  return data.result;
}

module.exports = async (req, res) => {
  const token = (req.query && req.query.token) || '';
  const expected = process.env.ADMIN_RESET_TOKEN;
  if (!expected || token !== expected) {
    res.status(403).json({ error: 'Prohibido' });
    return;
  }
  try {
    await kv(['SET', 'frag:contador_piezas', '0']);
    const keys = await kv(['KEYS', 'frag:pi:*']);
    let borradas = 0;
    if (Array.isArray(keys) && keys.length) {
      await kv(['DEL'].concat(keys));
      borradas = keys.length;
    }
    res.status(200).json({ ok: true, contador: 0, asignaciones_borradas: borradas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
