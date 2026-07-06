import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const urlParts = req.url.split('?')[0].split('/');
    const subIdx = urlParts.indexOf('subtitles');
    const type = urlParts[subIdx + 1];
    const id = urlParts[subIdx + 2].replace('.json', '');
    
    const subtitleUrls = (process.env.SUBTITLE_URLS || '').split(',').map(u => u.trim());
    const requests = subtitleUrls.map(url => 
        fetch(`${url}/subtitles/${type}/${id}.json`).then(r => r.json()).catch(() => ({ subtitles: [] }))
    );

    const results = await Promise.allSettled(requests);
    let allSubs = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value.subtitles || []);
    
    const uniqueSubs = Array.from(new Map(allSubs.map(s => [s.id, s])).values());
    uniqueSubs.sort((a, b) => (a.lang?.toLowerCase().includes('heb') ? -1 : 1));

    return res.status(200).json({ subtitles: uniqueSubs });
}
