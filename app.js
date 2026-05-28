/**
 * LandXML Alignment Visualizer for Trimble Connect
 */

let TC_API = null;
let alignments = [];
let activeMarkupIds = []; 

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
    } catch (e) {
        console.error("Failed to connect to TC:", e);
        updateStatus("Error: " + e.message);
    }
}

// UI Elements
const fileInput = document.getElementById('file-input');
const statusText = document.getElementById('status');
const alignmentList = document.getElementById('alignment-list');
const listItems = document.getElementById('list-items');
const drawBtn = document.getElementById('draw-btn');
const clearBtn = document.getElementById('clear-btn');

const drawAlignmentsCheck = document.getElementById('draw-alignments');
const drawStationingCheck = document.getElementById('draw-stationing');
const drawTextCheck = document.getElementById('draw-text');
const stationIntervalInput = document.getElementById('station-interval');
const fontSizeSlider = document.getElementById('font-size-slider');
const fontSizeVal = document.getElementById('font-size-val');

// Event Listeners
fileInput.addEventListener('change', handleFileSelect);
drawBtn.addEventListener('click', async () => {
    updateStatus("Preparing viewer...");
    await clearMarkups();
    await drawSelectedAlignments();
});
clearBtn.addEventListener('click', clearMarkups);
fontSizeSlider.addEventListener('input', () => {
    fontSizeVal.innerText = fontSizeSlider.value;
});

function updateStatus(text) {
    statusText.innerText = text;
}

async function clearMarkups() {
    if (!TC_API || !TC_API.markup) return;
    updateStatus("Clearing previous markups...");
    try {
        if (activeMarkupIds.length > 0) {
            const batchSize = 100;
            for (let i = 0; i < activeMarkupIds.length; i += batchSize) {
                const batch = activeMarkupIds.slice(i, i + batchSize);
                if (TC_API.markup.removeMarkups) await TC_API.markup.removeMarkups(batch);
                else if (TC_API.markup.removeLineMarkups) await TC_API.markup.removeLineMarkups(batch);
                else if (TC_API.markup.removeLineMarkup) {
                    for(const id of batch) await TC_API.markup.removeLineMarkup(id);
                }
            }
        }
        activeMarkupIds = [];
        updateStatus("Viewer cleared.");
    } catch (e) {
        console.error("Clear failed:", e);
    }
}

async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    updateStatus(`Reading ${file.name}...`);
    const reader = new FileReader();
    reader.onload = (e) => {
        const xmlText = e.target.result;
        parseLandXML(xmlText);
    };
    reader.readAsText(file);
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
    updateStatus(`Found ${alignments.length} alignments.`);
}

async function drawSelectedAlignments() {
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
        fontSize: parseInt(fontSizeSlider.value) || 10,
        swap: true 
    };

    updateStatus("Generating geometry...");
    
    const lines = [];
    const texts = [];

    for (const id of selectedIds) {
        const align = alignments[id];
        const geom = processAlignment(align, settings);
        lines.push(...geom.lines);
        texts.push(...geom.texts);
    }

    updateStatus(`Drawing ${lines.length + texts.length} elements...`);

    try {
        const batchSize = 40;
        
        const addItems = async (items, singularFn, pluralFn) => {
            for (let i = 0; i < items.length; i += batchSize) {
                const batch = items.slice(i, i + batchSize);
                let result;
                if (pluralFn) result = await pluralFn.call(TC_API.markup, batch);
                else if (singularFn) result = await singularFn.call(TC_API.markup, batch);

                if (Array.isArray(result)) {
                    result.forEach(r => {
                        if (r && r.id) activeMarkupIds.push(r.id);
                        else if (typeof r === 'string' || typeof r === 'number') activeMarkupIds.push(r);
                    });
                } else if (result) {
                    if (result.id) activeMarkupIds.push(result.id);
                    else if (typeof result === 'string' || typeof result === 'number') activeMarkupIds.push(result);
                }
            }
        };

        if (lines.length > 0) await addItems(lines, TC_API.markup.addLineMarkup, TC_API.markup.addLineMarkups);
        if (texts.length > 0) await addItems(texts, TC_API.markup.addTextMarkup, TC_API.markup.addTextMarkups);

        updateStatus("Drawing complete.");
    } catch (e) {
        console.error("Draw error:", e);
        updateStatus("Error: " + e.message);
    }
}

/**
 * Formats station to engineering format: KM X+YYY.ZZZ
 */
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

    // Use slider value to define "physical height" of the text (distance between start and end)
    // We scale the 6-30 value to a 0.5m - 5m range
    const textHeightM = (settings.fontSize / 10) * 1.5;

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
                    text: isExtreme ? (s === startSta ? `START KM ${formatStation(s)}` : `END KM ${formatStation(s)}`) : `KM ${formatStation(s)}`,
                    color: isExtreme ? { r: 255, g: 100, b: 0, a: 1 } : { r: 0, g: 255, b: 255, a: 1 },
                    start: pos,
                    // The distance between start and end defines the physical height/scale in many 3D viewers
                    end: { ...pos, positionZ: (el + textHeightM) * toMM }
                });
            }

            if (settings.drawSta) {
                const pN = interpolate(points, s + 0.1) || interpolate(points, s - 0.1);
                if (pN) {
                    const dx = pN.x - p.x, dy = pN.y - p.y;
                    const l = Math.sqrt(dx*dx + dy*dy);
                    if (l > 0.0001) {
                        const nx = -dy/l, ny = dx/l;
                        const tL = (s === startSta || s === endSta) ? 1.5 : 0.8; // Longer ticks for start/end
                        lines.push({
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
