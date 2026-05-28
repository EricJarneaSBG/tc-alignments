/**
 * LandXML Alignment Visualizer for Trimble Connect
 */

let TC_API = null;
let alignments = [];

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
        updateStatus("Error: Could not connect to Trimble Connect. (" + e.message + ")");
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

// Event Listeners
fileInput.addEventListener('change', handleFileSelect);
drawBtn.addEventListener('click', drawSelectedAlignments);
clearBtn.addEventListener('click', clearMarkups);

function updateStatus(text) {
    statusText.innerText = text;
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

async function clearMarkups() {
    if (!TC_API) return;
    updateStatus("Clearing viewer...");
    location.reload(); 
}

async function drawSelectedAlignments() {
    if (!TC_API) {
        alert("Not connected to Trimble Connect.");
        return;
    }

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
        swap: true // Swapping Northing/Easting is now on by default
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

    updateStatus(`Drawing ${lineMarkups.length} lines and ${textMarkups.length} labels...`);

    try {
        const batchSize = 50;
        
        // Helper to handle plural/singular API names
        const addBatch = async (items, singularFnName, pluralFnName) => {
            if (items.length === 0) return;
            
            const pluralFn = TC_API.markup[pluralFnName];
            const singularFn = TC_API.markup[singularFnName];

            for (let i = 0; i < items.length; i += batchSize) {
                const batch = items.slice(i, i + batchSize);
                try {
                    if (pluralFn) {
                        await pluralFn.call(TC_API.markup, batch);
                    } else if (singularFn) {
                        // Some versions expect singularFn to take an array anyway
                        await singularFn.call(TC_API.markup, batch);
                    }
                } catch (err) {
                    console.warn(`Batch error in ${pluralFnName}/${singularFnName}:`, err);
                    // Last resort: add one by one
                    if (singularFn) {
                        for (const item of batch) {
                            await singularFn.call(TC_API.markup, [item]);
                        }
                    }
                }
            }
        };

        await addBatch(lineMarkups, 'addLineMarkup', 'addLineMarkups');
        await addBatch(textMarkups, 'addTextMarkup', 'addTextMarkups');

        updateStatus("Drawing complete.");
    } catch (e) {
        console.error("Error drawing markups:", e);
        updateStatus("Error: " + e.message);
    }
}

function processAlignment(align, settings) {
    const lines = [];
    const texts = [];
    const points = [];
    const toMM = 1000;

    // 1. Parse Horizontal
    const coordGeom = align.node.getElementsByTagName('CoordGeom')[0];
    if (!coordGeom) return { lines, texts };

    const children = coordGeom.children;
    for (const child of children) {
        if (child.tagName === 'Line') {
            const start = parseCoord(child.getElementsByTagName('Start')[0].textContent, settings.swap);
            const end = parseCoord(child.getElementsByTagName('End')[0].textContent, settings.swap);
            const staStart = parseFloat(child.getAttribute('staStart'));
            const length = parseFloat(child.getAttribute('length'));
            
            points.push({ x: start.x, y: start.y, sta: staStart });
            points.push({ x: end.x, y: end.y, sta: staStart + length });

        } else if (child.tagName === 'Curve') {
            const start = parseCoord(child.getElementsByTagName('Start')[0].textContent, settings.swap);
            const center = parseCoord(child.getElementsByTagName('Center')[0].textContent, settings.swap);
            const end = parseCoord(child.getElementsByTagName('End')[0].textContent, settings.swap);
            const staStart = parseFloat(child.getAttribute('staStart'));
            const length = parseFloat(child.getAttribute('length'));
            const radius = parseFloat(child.getAttribute('radius'));
            const rot = child.getAttribute('rot');

            const segments = Math.max(2, Math.ceil(length / 5));
            const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
            let endAngle = Math.atan2(end.y - center.y, end.x - center.x);

            if (rot === 'cw' && endAngle > startAngle) endAngle -= 2 * Math.PI;
            if (rot === 'ccw' && endAngle < startAngle) endAngle += 2 * Math.PI;

            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const angle = startAngle + t * (endAngle - startAngle);
                points.push({
                    x: center.x + radius * Math.cos(angle),
                    y: center.y + radius * Math.sin(angle),
                    sta: staStart + t * length
                });
            }
        }
    }

    // 2. Vertical
    const pvis = [];
    if (align.profile) {
        const pviNodes = align.profile.getElementsByTagName('PVI');
        for (let i = 0; i < pviNodes.length; i++) {
            const parts = pviNodes[i].textContent.trim().split(/\s+/);
            pvis.push({ sta: parseFloat(parts[0]), elev: parseFloat(parts[1]) });
        }
    }

    const getElevation = (sta) => {
        if (pvis.length === 0) return 0;
        if (sta <= pvis[0].sta) return pvis[0].elev;
        if (sta >= pvis[pvis.length - 1].sta) return pvis[pvis.length - 1].elev;
        for (let i = 0; i < pvis.length - 1; i++) {
            if (sta >= pvis[i].sta && sta <= pvis[i+1].sta) {
                const t = (sta - pvis[i].sta) / (pvis[i+1].sta - pvis[i].sta);
                return pvis[i].elev + t * (pvis[i+1].elev - pvis[i].elev);
            }
        }
        return 0;
    };

    // 3. Create Markups
    if (settings.drawAlign) {
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i+1];
            if (Math.abs(p1.x - p2.x) < 0.001 && Math.abs(p1.y - p2.y) < 0.001) continue;

            lines.push({
                color: { r: 255, g: 255, b: 0, a: 1 },
                start: { positionX: p1.x * toMM, positionY: p1.y * toMM, positionZ: getElevation(p1.sta) * toMM },
                end: { positionX: p2.x * toMM, positionY: p2.y * toMM, positionZ: getElevation(p2.sta) * toMM }
            });
        }
    }

    if (settings.drawSta || settings.drawText) {
        const startSta = points[0]?.sta || 0;
        const endSta = points[points.length - 1]?.sta || 0;
        
        for (let s = Math.ceil(startSta / settings.interval) * settings.interval; s <= endSta; s += settings.interval) {
            const p = interpolateHorizontal(points, s);
            if (!p) continue;
            const elev = getElevation(s);
            const pos = { positionX: p.x * toMM, positionY: p.y * toMM, positionZ: elev * toMM };

            if (settings.drawText) {
                texts.push({
                    text: `KM ${ (s/1000).toFixed(3) }`,
                    color: { r: 0, g: 255, b: 255, a: 1 },
                    fontSize: 12, // Attempt to set a smaller font size
                    start: pos,
                    end: { ...pos, positionZ: (elev + 1.5) * toMM } 
                });
            }

            if (settings.drawSta) {
                const pNext = interpolateHorizontal(points, s + 0.1);
                if (pNext) {
                    const dx = pNext.x - p.x;
                    const dy = pNext.y - p.y;
                    const len = Math.sqrt(dx*dx + dy*dy);
                    const nx = -dy / len;
                    const ny = dx / len;
                    const tickLen = 1.5;

                    lines.push({
                        color: { r: 0, g: 255, b: 255, a: 1 },
                        start: { positionX: (p.x - nx * tickLen) * toMM, positionY: (p.y - ny * tickLen) * toMM, positionZ: elev * toMM },
                        end: { positionX: (p.x + nx * tickLen) * toMM, positionY: (p.y + ny * tickLen) * toMM, positionZ: elev * toMM }
                    });
                }
            }
        }
    }

    return { lines, texts };
}

function parseCoord(str, swap) {
    const parts = str.trim().split(/\s+/);
    const v1 = parseFloat(parts[0]);
    const v2 = parseFloat(parts[1]);
    return swap ? { x: v2, y: v1 } : { x: v1, y: v2 };
}

function interpolateHorizontal(points, sta) {
    if (points.length === 0) return null;
    if (sta <= points[0].sta) return points[0];
    if (sta >= points[points.length - 1].sta) return points[points.length - 1];
    for (let i = 0; i < points.length - 1; i++) {
        if (sta >= points[i].sta && sta <= points[i+1].sta) {
            const t = (sta - points[i].sta) / (points[i+1].sta - points[i].sta);
            return {
                x: points[i].x + t * (points[i+1].x - points[i].x),
                y: points[i].y + t * (points[i+1].y - points[i].y)
            };
        }
    }
    return null;
}

initTC();
