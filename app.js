/**
 * LandXML Alignment Visualizer for Trimble Connect
 */

let TC_API = null;
let alignments = [];
let activeMarkupIds = []; 
let idCounter = 1; 

// UI Elements
const statusText = document.getElementById('status');
const alignmentList = document.getElementById('alignment-list');
const listItems = document.getElementById('list-items');
const drawBtn = document.getElementById('draw-btn');
const clearBtn = document.getElementById('clear-btn');
const projectFilesDropdown = document.getElementById('project-files');
const reloadFilesBtn = document.getElementById('reload-files-btn');

const drawAlignmentsCheck = document.getElementById('draw-alignments');
const drawStationingCheck = document.getElementById('draw-stationing');
const drawTextCheck = document.getElementById('draw-text');
const stationIntervalInput = document.getElementById('station-interval');

// Tab Switching
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        tabContents.forEach(content => {
            if (content.id === `${targetTab}-tab`) content.classList.remove('hidden');
            else content.classList.add('hidden');
        });
    });
});

// Initialize Trimble Connect API
async function initTC() {
    try {
        const getApi = () => (typeof TrimbleConnectWorkspace !== 'undefined' ? TrimbleConnectWorkspace : 
                             (typeof TrimbleConnectWorkspaceApi !== 'undefined' ? TrimbleConnectWorkspaceApi : undefined));

        if (!getApi()) {
            let attempts = 0;
            while (!getApi() && attempts < 50) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
        }

        const ApiObject = getApi();
        if (!ApiObject) throw new Error("Trimble Connect SDK not loaded.");

        TC_API = await ApiObject.connect(window.parent, (event, data) => {}, 30000);
        updateStatus("Connected to Trimble Connect.");
        await loadProjectFiles();
    } catch (e) {
        console.error("Failed to connect to TC:", e);
        updateStatus("Error: " + e.message);
    }
}

// Event Listeners
reloadFilesBtn.addEventListener('click', loadProjectFiles);
projectFilesDropdown.addEventListener('change', handleFileSelection);
drawBtn.addEventListener('click', async () => {
    updateStatus("Clearing and drawing...");
    await clearMarkups();
    await new Promise(r => setTimeout(r, 200)); 
    await drawSelectedAlignments();
});
clearBtn.addEventListener('click', clearMarkups);

function updateStatus(text) { statusText.innerText = text; }

/**
 * Robust Project File Loader
 * Tries multiple methods to bypass regional 403/404 issues.
 */
async function loadProjectFiles() {
    if (!TC_API) return;
    updateStatus("Loading project files...");
    projectFilesDropdown.innerHTML = '<option value="">-- Loading... --</option>';

    try {
        const project = await TC_API.project.getProject();
        const token = await TC_API.extension.requestPermission("accesstoken");
        
        const endpoints = [
            "https://app.connect.trimble.com/tc/api/2.0",
            "https://app21.connect.trimble.com/tc/api/2.0"
        ];

        // Ensure we try both, but prioritize based on project location
        if (project.location === "europe" || project.location === "europe-west") endpoints.reverse();

        let items = [];
        let baseUrlUsed = "";

        for (const baseUrl of endpoints) {
            console.log(`Checking API: ${baseUrl}`);
            try {
                // Try 1: Get root folder directly via /projects/{id}
                const pResp = await fetch(`${baseUrl}/projects/${project.id}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                
                let folderId = project.id;
                if (pResp.ok) {
                    const pData = await pResp.json();
                    folderId = pData.rootFolderId || folderId;
                }

                // Try 2: List items
                const response = await fetch(`${baseUrl}/folders/${folderId}/items`, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Range': 'items=0-200' }
                });

                if (response.ok) {
                    items = await response.json();
                    baseUrlUsed = baseUrl;
                    break;
                }
            } catch (e) { console.warn(`Error with ${baseUrl}:`, e); }
        }

        if (items.length === 0) {
            // Fallback: Try searching for XMLs in the project if the folder list failed
            updateStatus("Retrying file search...");
            // This is a last resort if standard folder listing is forbidden
        }

        const landXmlFiles = items.filter(i => i.type === 'FILE' && (i.name.toLowerCase().endsWith('.xml') || i.name.toLowerCase().endsWith('.landxml')));
        projectFilesDropdown.innerHTML = landXmlFiles.length > 0 ? '<option value="">-- Select LandXML --</option>' : '<option value="">-- No XMLs Found --</option>';
        
        landXmlFiles.forEach(file => {
            const opt = document.createElement('option');
            opt.value = file.id;
            opt.textContent = file.name;
            opt.dataset.baseUrl = baseUrlUsed;
            projectFilesDropdown.appendChild(opt);
        });

        updateStatus(`Found ${landXmlFiles.length} LandXML files.`);
    } catch (e) {
        console.error("Load files error:", e);
        updateStatus("Error: Access denied or project not found.");
    }
}

async function handleFileSelection() {
    const fileId = projectFilesDropdown.value;
    if (!fileId) return;
    const selectedOption = projectFilesDropdown.selectedOptions[0];
    const baseUrl = selectedOption.dataset.baseUrl;

    updateStatus(`Fetching XML content...`);
    try {
        const token = await TC_API.extension.requestPermission("accesstoken");
        const dlResponse = await fetch(`${baseUrl}/files/${fileId}/downloadUrl`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!dlResponse.ok) throw new Error("Download URL denied");
        const dlData = await dlResponse.json();
        const contentResponse = await fetch(dlData.url);
        const xmlText = await contentResponse.text();
        parseLandXML(xmlText);
    } catch (e) {
        updateStatus("Error downloading file.");
    }
}

function parseLandXML(xmlText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
    const alignmentNodes = xmlDoc.getElementsByTagName('Alignment');
    alignments = [];
    listItems.innerHTML = '';

    if (alignmentNodes.length === 0) {
        updateStatus("No alignments in file.");
        return;
    }

    for (let i = 0; i < alignmentNodes.length; i++) {
        const node = alignmentNodes[i];
        const name = node.getAttribute('name') || `Alignment ${i+1}`;
        const alignment = { id: i, name: name, node: node, profile: null };
        const profileNodes = xmlDoc.getElementsByTagName('Profile');
        for (let j = 0; j < profileNodes.length; j++) {
            if (profileNodes[j].getAttribute('name') === name) {
                alignment.profile = profileNodes[j];
                break;
            }
        }
        alignments.push(alignment);
        const div = document.createElement('div');
        div.className = 'alignment-item';
        div.innerHTML = `<input type="checkbox" id="align-${i}" value="${i}" checked><label for="align-${i}">${name}</label>`;
        listItems.appendChild(div);
    }
    alignmentList.classList.remove('hidden');
    updateStatus(`Alignments loaded.`);
}

async function clearMarkups() {
    if (!TC_API || !TC_API.markup || activeMarkupIds.length === 0) return;
    try {
        const removeFn = TC_API.markup.removeMarkups || TC_API.markup.removeLineMarkups;
        if (removeFn) {
            for (let i = 0; i < activeMarkupIds.length; i += 100) {
                await removeFn.call(TC_API.markup, activeMarkupIds.slice(i, i + 100));
            }
        }
        activeMarkupIds = [];
        updateStatus("Cleared.");
    } catch (e) { activeMarkupIds = []; }
}

async function drawSelectedAlignments() {
    const selectedIds = Array.from(listItems.querySelectorAll('input:checked')).map(cb => parseInt(cb.value));
    if (selectedIds.length === 0) return;

    const settings = {
        drawAlign: drawAlignmentsCheck.checked,
        drawSta: drawStationingCheck.checked,
        drawText: drawTextCheck.checked,
        interval: parseFloat(stationIntervalInput.value) || 100,
        swap: true 
    };

    updateStatus("Processing...");
    const lines = [], texts = [];
    for (const id of selectedIds) {
        const geom = processAlignment(alignments[id], settings);
        lines.push(...geom.lines);
        texts.push(...geom.texts);
    }

    try {
        const add = async (items, sing, plur) => {
            for (let i = 0; i < items.length; i += 40) {
                const batch = items.slice(i, i + 40);
                let res;
                if (plur) res = await plur.call(TC_API.markup, batch);
                else if (sing) { for (const itm of batch) res = await sing.call(TC_API.markup, itm); }
                if (Array.isArray(res)) res.forEach(r => activeMarkupIds.push(r.id || r));
                else if (res) activeMarkupIds.push(res.id || res);
            }
        };
        await add(lines, TC_API.markup.addLineMarkup, TC_API.markup.addLineMarkups);
        await add(texts, TC_API.markup.addTextMarkup, TC_API.markup.addTextMarkups);
        updateStatus("Drawing complete.");
    } catch (e) { updateStatus("Draw failed."); }
}

function formatStation(s) {
    const km = Math.floor(s / 1000);
    const m = (s % 1000).toFixed(3).split('.');
    return `${km}+${m[0].padStart(3, '0')}${m[1] !== '000' ? '.' + m[1] : ''}`;
}

function processAlignment(align, settings) {
    const lines = [], texts = [], points = [], toMM = 1000;
    const cg = align.node.getElementsByTagName('CoordGeom')[0];
    if (!cg) return { lines, texts };
    for (const child of cg.children) {
        if (child.tagName === 'Line') {
            const s = parseCoord(child.getElementsByTagName('Start')[0]?.textContent, settings.swap);
            const e = parseCoord(child.getElementsByTagName('End')[0]?.textContent, settings.swap);
            const sta = parseFloat(child.getAttribute('staStart')), len = parseFloat(child.getAttribute('length'));
            if (s && e) { points.push({ ...s, sta: sta }); points.push({ ...e, sta: sta + len }); }
        } else if (child.tagName === 'Curve') {
            const s = parseCoord(child.getElementsByTagName('Start')[0]?.textContent, settings.swap);
            const c = parseCoord(child.getElementsByTagName('Center')[0]?.textContent, settings.swap);
            const e = parseCoord(child.getElementsByTagName('End')[0]?.textContent, settings.swap);
            const sta = parseFloat(child.getAttribute('staStart')), len = parseFloat(child.getAttribute('length')), rad = parseFloat(child.getAttribute('radius')), rot = child.getAttribute('rot');
            if (s && c && e) {
                const segs = Math.max(2, Math.ceil(len / 10)), sA = Math.atan2(s.y - c.y, s.x - c.x);
                let eA = Math.atan2(e.y - c.y, e.x - c.x);
                if (rot === 'cw' && eA > sA) eA -= 2 * Math.PI;
                if (rot === 'ccw' && eA < sA) eA += 2 * Math.PI;
                for (let i = 0; i <= segs; i++) {
                    const t = i / segs, a = sA + t * (eA - sA);
                    points.push({ x: c.x + rad * Math.cos(a), y: c.y + rad * Math.sin(a), sta: sta + t * len });
                }
            }
        }
    }
    const pvis = [];
    if (align.profile) {
        const pNodes = align.profile.getElementsByTagName('PVI');
        for (let i = 0; i < pNodes.length; i++) {
            const pts = pNodes[i].textContent.trim().split(/\s+/);
            if (pts.length >= 2) pvis.push({ sta: parseFloat(pts[0]), elev: parseFloat(pts[1]) });
        }
    }
    const getEl = (s) => {
        if (!pvis.length) return 0;
        if (s <= pvis[0].sta) return pvis[0].elev;
        if (s >= pvis[pvis.length-1].sta) return pvis[pvis.length-1].elev;
        for (let i = 0; i < pvis.length - 1; i++) if (s >= pvis[i].sta && s <= pvis[i+1].sta) return pvis[i].elev + ((s - pvis[i].sta) / (pvis[i+1].sta - pvis[i].sta)) * (pvis[i+1].elev - pvis[i].elev);
        return 0;
    };
    if (settings.drawAlign) {
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i], p2 = points[i+1];
            if (dist(p1, p2) < 0.001) continue;
            lines.push({ id: idCounter++, color: { r: 255, g: 255, b: 0, a: 1 }, start: { positionX: p1.x * toMM, positionY: p1.y * toMM, positionZ: getEl(p1.sta) * toMM }, end: { positionX: p2.x * toMM, positionY: p2.y * toMM, positionZ: getEl(p2.sta) * toMM } });
        }
    }
    if (settings.drawSta || settings.drawText) {
        const sSta = points[0]?.sta || 0, eSta = points[points.length-1]?.sta || 0, stations = [sSta];
        for (let s = Math.ceil(sSta / settings.interval) * settings.interval; s < eSta; s += settings.interval) if (s > sSta + 0.01) stations.push(s);
        if (eSta > sSta + 0.01) stations.push(eSta);
        for (const s of stations) {
            const p = interpolate(points, s);
            if (!p) continue;
            const el = getEl(s), pos = { positionX: p.x * toMM, positionY: p.y * toMM, positionZ: el * toMM };
            if (settings.drawText) {
                const isEx = (s === sSta || s === eSta);
                texts.push({ id: idCounter++, text: isEx ? (s === sSta ? `START KM ${formatStation(s)}` : `END KM ${formatStation(s)}`) : `KM ${formatStation(s)}`, color: isEx ? { r: 255, g: 100, b: 0, a: 1 } : { r: 0, g: 255, b: 255, a: 1 }, start: pos, end: { ...pos, positionZ: (el + 1.5) * toMM } });
            }
            if (settings.drawSta) {
                const pN = interpolate(points, s + 0.1) || interpolate(points, s - 0.1);
                if (pN) {
                    const dx = pN.x - p.x, dy = pN.y - p.y, l = Math.sqrt(dx*dx + dy*dy);
                    if (l > 0.0001) {
                        const nx = -dy/l, ny = dx/l, tL = (s === sSta || s === eSta) ? 1.5 : 0.8;
                        lines.push({ id: idCounter++, color: (s === sSta || s === eSta) ? { r: 255, g: 100, b: 0, a: 1 } : { r: 0, g: 255, b: 255, a: 1 }, start: { positionX: (p.x - nx*tL)*toMM, positionY: (p.y - ny*tL)*toMM, positionZ: el*toMM }, end: { positionX: (p.x + nx*tL)*toMM, positionY: (p.y + ny*tL)*toMM, positionZ: el*toMM } });
                    }
                }
            }
        }
    }
    return { lines, texts };
}

function isValid(p) { return p && !isNaN(p.x) && !isNaN(p.y); }
function dist(p1, p2) { return Math.sqrt(Math.pow(p1.x-p2.x, 2) + Math.pow(p1.y-p2.y, 2)); }
function parseCoord(str, swap) {
    if (!str) return null;
    const pts = str.trim().split(/\s+/);
    return swap ? { x: parseFloat(pts[1]), y: parseFloat(pts[0]) } : { x: parseFloat(pts[0]), y: parseFloat(pts[1]) };
}
function interpolate(pts, s) {
    if (!pts.length) return null;
    if (s <= pts[0].sta + 0.001) return pts[0];
    if (s >= pts[pts.length-1].sta - 0.001) return pts[pts.length-1];
    for (let i = 0; i < pts.length - 1; i++) if (s >= pts[i].sta && s <= pts[i+1].sta) {
        const t = (s - pts[i].sta) / (pts[i+1].sta - pts[i].sta);
        return { x: pts[i].x + t*(pts[i+1].x-pts[i].x), y: pts[i].y + t*(pts[i+1].y-pts[i].y) };
    }
    return null;
}

initTC();
