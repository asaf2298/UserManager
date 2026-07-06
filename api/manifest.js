export default async function handler(req, res) {
    const pathParts = req.url.split('/');
    const user = pathParts[1] || 'default'; // לוקח את שם המשתמש מהנתיב
    const configs = JSON.parse(process.env.USER_CONFIGS || '{}');
    const userConfig = configs[user] || { catalog: '', profile: 'friends_light' };

    const manifest = {
        id: `com.vecret.${user}`,
        version: '1.0.0',
        name: `Vecret - ${user}`,
        description: `Private Proxy for ${user}`,
        types: ['movie', 'series', 'anime'],
        catalogs: userConfig.catalog ? [{ type: 'movie', id: 'vecret_catalog' }] : [],
        resources: ['stream', 'subtitles'],
        idPrefixes: ['tt']
    };

    return res.status(200).json(manifest);
}
