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

// Initialize Trimble Connect API
async function initTC() {
    try {
        const getApi = () => (typeof TrimbleConnectWorkspace !== 'undefined' ? TrimbleConnectWorkspace : 
                             (typeof TrimbleConnectWorkspaceApi !== 'undefined' ? TrimbleConnectWorkspaceApi : undefined));

        if (!getApi()) {
            console.log("Waiting for SDK...");
            let attempts = 0;
            while (!getApi() && attempts < 50) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
        }

        const ApiObject = getApi();
        if (!ApiObject) {
            throw new Error("Trimble Connect SDK script not loaded.");
        }

        TC_API = await ApiObject.connect(window.parent, (event, data) => {
            console.log("TC Event:", event, data);
        }, 30000);
        
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
    updateStatus("Preparing viewer...");
    await clearMarkups();
    await new Promise(r => setTimeout(r, 200)); 
    await drawSelectedAlignments();
});
clearBtn.addEventListener('click', clearMarkups);

function updateStatus(text) {
    statusText.innerText = text;
}

/**
 * Fetch files from the current project.
 */
async function loadProjectFiles() {
    if (!TC_API) return;
    
    updateStatus("Loading project files...");
    projectFilesDropdown.innerHTML = '<option value="">-- Loading... --</option>';

    try {
        const project = await TC_API.project.getCurrentProject();
        const token = await TC_API.extension.requestPermission("accesstoken");
        
        console.log("Current Project Data:", project);

        // Determine API Base URL using project.location
        let baseUrl = "https://app.connect.trimble.com/tc/api/2.0";
        if (project.location === "europe" || project.location === "europe-west") {
            baseUrl = "https://app21.connect.trimble.com/tc/api/2.0";
        } else if (project.location === "asia" || project.location === "asia-pacific") {
            baseUrl = "https://app31.connect.trimble.com/tc/api/2.0";
        }

        console.log(`Region: ${project.location}. Using API: ${baseUrl}`);
        const folderId = project.id; // Root folder ID is the Project ID in 2.0 API

        // Root folder ID is the same as project ID in many cases, but rootFolderId is more explicit
        const response = await fetch(`${baseUrl}/folders/${folderId}/items`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) throw new Error(`API Error: ${response.status}`);

        const items = await response.json();
        const landXmlFiles = items.filter(i => i.type === 'FILE' && (i.name.toLowerCase().endsWith('.xml') || i.name.toLowerCase().endsWith('.landxml')));

        projectFilesDropdown.innerHTML = '<option value="">-- Select LandXML --</option>';
        landXmlFiles.forEach(file => {
            const opt = document.createElement('option');
            opt.value = file.id;
            opt.textContent = file.name;
            opt.dataset.baseUrl = baseUrl;
            projectFilesDropdown.appendChild(opt);
        });

        updateStatus(`Found ${landXmlFiles.length} LandXML files.`);
    } catch (e) {
        console.error("Failed to load files:", e);
        updateStatus("Error loading files. Check console.");
        projectFilesDropdown.innerHTML = '<option value="">-- Error --</option>';
    }
}

async function handleFileSelection() {
    const fileId = projectFilesDropdown.value;
    if (!fileId) return;

    const selectedOption = projectFilesDropdown.selectedOptions[0];
    const baseUrl = selectedOption.dataset.baseUrl;

    updateStatus(`Fetching file content...`);
    
    try {
        const token = await TC_API.extension.requestPermission("accesstoken");
        
        // 1. Get download URL
        const dlResponse = await fetch(`${baseUrl}/files/${fileId}/downloadUrl`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!dlResponse.ok) throw new Error("Failed to get download URL");
        
        const dlData = await dlResponse.json();
        
        // 2. Fetch the actual content
        const contentResponse = await fetch(dlData.url);
        if (!contentResponse.ok) throw new Error("Failed to download file content");
        
        const xmlText = await contentResponse.text();
        parseLandXML(xmlText);
    } catch (e) {
        console.error("Fetch error:", e);
        updateStatus("Error fetching file.");
    }
}

function parseLandXML(xmlText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
    
    const alignmentNodes = xmlDoc.getElementsByTagName('Alignment');
    alignments = [];
    listItems.innerHTML = '';

    if (alignmentNodes.length === 0) {
        updateStatus("No alignments found in file.");
        return;
    }

    for (let i = 0; i < alignmentNodes.length; i++) {
        const node = alignmentNodes[i];
        const name = node.getAttribute('name') || `Alignment ${i+1}`;
        const desc = node.getAttribute('desc') || '';
        
        const alignment = {
            id: i,
            name: name,
            desc: desc,
            node: node,
            profile: null
        };

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
        div.innerHTML = `
            <input type="checkbox" id="align-${i}" value="${i}" checked>
            <label for="align-${i}">${name} ${desc ? '('+desc+')' : ''}</label>
        `;
        listItems.appendChild(div);
    }

    alignmentList.classList.remove('hidden');
    updateStatus(`Found ${alignments.length} alignments in selected file.`);
}

async function clearMarkups() {
    if (!TC_API || !TC_API.markup) return;
    if (activeMarkupIds.length === 0) return;

    updateStatus("Clearing previous markups...");
    try {
        const batchSize = 100;
        const removeFn = TC_API.markup.removeMarkups || TC_API.markup.removeLineMarkups;
        if (removeFn) {
            for (let i = 0; i < activeMarkupIds.length; i += batchSize) {
                const batch = activeMarkupIds.slice(i, i + batchSize);
                await removeFn.call(TC_API.markup, batch);
            }
        }
        activeMarkupIds = [];
        updateStatus("Viewer cleared.");
    } catch (e) {
        console.error("Clear failed:", e);
        activeMarkupIds = []; 
    }
}

async function drawSelectedAlignments() {
    if (!TC_API) return;

    const selectedIds = Array.from(listItems.querySelectorAll('input:checked')).map(cb => parseInt(cb.value));
    if (selectedIds.length === 0) {
        alert("Please select at least one alignment.");
        return;
    }

    const settings = {
        drawAlign: drawAlignmentsCheck.checked,
        drawSta: drawStationingCheck.checked,
        drawText: drawTextCheck.checked,
        interval: parseFloat(stationIntervalInput.value) || 100,
        swap: true 
    };

    updateStatus("Generating geometry...");
    
    const lineMarkups = [];
    const textMarkups = [];

    for (const id of selectedIds) {
        const align = alignments[id];
        const geom = processAlignment(align, settings);
        lineMarkups.push(...geom.lines);
        textMarkups.push(...geom.texts);
    }

    updateStatus(`Drawing ${lineMarkups.length + textMarkups.length} elements...`);

    try {
        const batchSize = 50;
        
        const addItems = async (items, singularFn, pluralFn) => {
            for (let i = 0; i < items.length; i += batchSize) {
                const batch = items.slice(i, i + batchSize);
                if (pluralFn) await pluralFn.call(TC_API.markup, batch);
                else if (singularFn) {
                    for (const item of batch) await singularFn.call(TC_API.markup, item);
                }
                batch.forEach(item => { if (item.id) activeMarkupIds.push(item.id); });
            }
        };

        if (lineMarkups.length > 0) await addItems(lineMarkups, TC_API.markup.addLineMarkup, TC_API.markup.addLineMarkups);
        if (textMarkups.length > 0) await addItems(textMarkups, TC_API.markup.addTextMarkup, TC_API.markup.addTextMarkups);

        updateStatus("Drawing complete.");
    } catch (e) {
        console.error("Draw error:", e);
        updateStatus("Error: " + e.message);
    }
}

function formatStation(s) {
    const km = Math.floor(s / 1000);
    const m = (s % 1000).toFixed(3);
    const mParts = m.split('.');
    const paddedM = mParts[0].padStart(3, '0');
    return `${km}+${paddedM}${mParts[1] !== '000' ? '.' + mParts[1] : ''}`;
}

function processAlignment(align, settings) {
    const lines = [];
    const texts = [];
    const points = [];
    const toMM = 1000;
    const labelHeightM = 1.5;

    const coordGeom = align.node.getElementsByTagName('CoordGeom')[0];
    if (!coordGeom) return { lines, texts };

    const children = coordGeom.children;
    for (const child of children) {
        if (child.tagName === 'Line') {
            const start = parseCoord(child.getElementsByTagName('Start')[0]?.textContent, settings.swap);
            const end = parseCoord(child.getElementsByTagName('End')[0]?.textContent, settings.swap);
            const staStart = parseFloat(child.getAttribute('staStart'));
            const length = parseFloat(child.getAttribute('length'));
            if (isValid(start) && isValid(end)) {
                points.push({ ...start, sta: staStart });
                points.push({ ...end, sta: staStart + length });
            }
        } else if (child.tagName === 'Curve') {
            const start = parseCoord(child.getElementsByTagName('Start')[0]?.textContent, settings.swap);
            const center = parseCoord(child.getElementsByTagName('Center')[0]?.textContent, settings.swap);
            const end = parseCoord(child.getElementsByTagName('End')[0]?.textContent, settings.swap);
            const staStart = parseFloat(child.getAttribute('staStart'));
            const length = parseFloat(child.getAttribute('length'));
            const radius = parseFloat(child.getAttribute('radius'));
            const rot = child.getAttribute('rot');

            if (isValid(start) && isValid(center) && isValid(end)) {
                const segs = Math.max(2, Math.ceil(length / 10));
                const sAng = Math.atan2(start.y - center.y, start.x - center.x);
                let eAng = Math.atan2(end.y - center.y, end.x - center.x);
                if (rot === 'cw' && eAng > sAng) eAng -= 2 * Math.PI;
                if (rot === 'ccw' && eAng < sAng) eAng += 2 * Math.PI;
                for (let i = 0; i <= segs; i++) {
                    const t = i / segs;
                    const a = sAng + t * (eAng - sAng);
                    points.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a), sta: staStart + t * length });
                }
            }
        }
    }

    const pvis = [];
    if (align.profile) {
        const pviNodes = align.profile.getElementsByTagName('PVI');
        for (let i = 0; i < pviNodes.length; i++) {
            const parts = pviNodes[i].textContent.trim().split(/\s+/);
            if (parts.length >= 2) pvis.push({ sta: parseFloat(parts[0]), elev: parseFloat(parts[1]) });
        }
    }

    const getElev = (s) => {
        if (!pvis.length) return 0;
        if (s <= pvis[0].sta) return pvis[0].elev;
        if (s >= pvis[pvis.length-1].sta) return pvis[pvis.length-1].elev;
        for (let i = 0; i < pvis.length - 1; i++) {
            if (s >= pvis[i].sta && s <= pvis[i+1].sta) {
                const t = (s - pvis[i].sta) / (pvis[i+1].sta - pvis[i].sta);
                return pvis[i].elev + t * (pvis[i+1].elev - pvis[i].elev);
            }
        }
        return 0;
    };

    if (settings.drawAlign) {
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i], p2 = points[i+1];
            if (dist(p1, p2) < 0.001) continue;
            lines.push({
                id: idCounter++,
                color: { r: 255, g: 255, b: 0, a: 1 },
                start: { positionX: p1.x * toMM, positionY: p1.y * toMM, positionZ: getElev(p1.sta) * toMM },
                end: { positionX: p2.x * toMM, positionY: p2.y * toMM, positionZ: getElev(p2.sta) * toMM }
            });
        }
    }

    if (settings.drawSta || settings.drawText) {
        const startSta = points[0]?.sta || 0;
        const endSta = points[points.length-1]?.sta || 0;
        const stations = [startSta];
        for (let s = Math.ceil(startSta / settings.interval) * settings.interval; s < endSta; s += settings.interval) {
            if (s > startSta + 0.01) stations.push(s);
        }
        if (endSta > startSta + 0.01) stations.push(endSta);

        for (const s of stations) {
            const p = interpolate(points, s);
            if (!p) continue;
            const el = getElev(s);
            const pos = { positionX: p.x * toMM, positionY: p.y * toMM, positionZ: el * toMM };

            if (settings.drawText) {
                const isExtreme = (s === startSta || s === endSta);
                texts.push({
                    id: idCounter++,
                    text: isExtreme ? (s === startSta ? `START KM ${formatStation(s)}` : `END KM ${formatStation(s)}`) : `KM ${formatStation(s)}`,
                    color: isExtreme ? { r: 255, g: 100, b: 0, a: 1 } : { r: 0, g: 255, b: 255, a: 1 },
                    start: pos,
                    end: { ...pos, positionZ: (el + labelHeightM) * toMM }
                });
            }

            if (settings.drawSta) {
                const pN = interpolate(points, s + 0.1) || interpolate(points, s - 0.1);
                if (pN) {
                    const dx = pN.x - p.x, dy = pN.y - p.y;
                    const l = Math.sqrt(dx*dx + dy*dy);
                    if (l > 0.0001) {
                        const nx = -dy/l, ny = dx/l, tL = (s === startSta || s === endSta) ? 1.5 : 0.8;
                        lines.push({
                            id: idCounter++,
                            color: (s === startSta || s === endSta) ? { r: 255, g: 100, b: 0, a: 1 } : { r: 0, g: 255, b: 255, a: 1 },
                            start: { positionX: (p.x - nx*tL)*toMM, positionY: (p.y - ny*tL)*toMM, positionZ: el*toMM },
                            end: { positionX: (p.x + nx*tL)*toMM, positionY: (p.y + ny*tL)*toMM, positionZ: el*toMM }
                        });
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
    const v1 = parseFloat(pts[0]), v2 = parseFloat(pts[1]);
    return swap ? { x: v2, y: v1 } : { x: v1, y: v2 };
}
function interpolate(pts, s) {
    if (!pts.length) return null;
    if (s <= pts[0].sta + 0.001) return pts[0];
    if (s >= pts[pts.length-1].sta - 0.001) return pts[pts.length-1];
    for (let i = 0; i < pts.length - 1; i++) {
        if (s >= pts[i].sta && s <= pts[i+1].sta) {
            const t = (s - pts[i].sta) / (pts[i+1].sta - pts[i].sta);
            return { x: pts[i].x + t*(pts[i+1].x-pts[i].x), y: pts[i].y + t*(pts[i+1].y-pts[i].y) };
        }
    }
    return null;
}

initTC();
