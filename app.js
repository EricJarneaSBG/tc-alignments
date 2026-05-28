/**
 * LandXML Alignment Visualizer for Trimble Connect
 */

let TC_API = null;
let alignments = [];

// Initialize Trimble Connect API
async function initTC() {
    try {
        TC_API = await WorkspaceAPI.connect(window.parent, (event, data) => {
            console.log("TC Event:", event, data);
        });
        updateStatus("Connected to Trimble Connect.");
    } catch (e) {
        console.error("Failed to connect to TC:", e);
        updateStatus("Error: Could not connect to Trimble Connect. Are you running this as an extension?");
    }
}

// UI Elements
const fileInput = document.getElementById('file-input');
const statusText = document.getElementById('status');
const alignmentList = document.getElementById('alignment-list');
const listItems = document.getElementById('list-items');
const drawBtn = document.getElementById('draw-btn');
const clearBtn = document.getElementById('clear-btn');
const swapCoordsCheckbox = document.getElementById('swap-coords');
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

        // Try to find matching profile
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
    try {
        // There isn't a direct "clear all" usually, we might need to track IDs or just wait for page refresh.
        // But MarkupAPI might have a way.
        updateStatus("Clearing viewer...");
        // For now, we'll just try to clear by reloading or if the API supports it.
        // Some versions support API.markup.removeMarkups([]) with empty array? Unlikely.
        // Usually, we'd need to keep track of IDs.
        location.reload(); // Simplest way to clear runtime markups if they aren't persisted.
    } catch (e) {
        console.error(e);
    }
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

    updateStatus("Generating geometry...");
    
    const lineMarkups = [];
    const textMarkups = [];
    const interval = parseFloat(stationIntervalInput.value) || 100;
    const swap = swapCoordsCheckbox.checked;

    for (const id of selectedIds) {
        const align = alignments[id];
        const geom = processAlignment(align, interval, swap);
        lineMarkups.push(...geom.lines);
        textMarkups.push(...geom.texts);
    }

    updateStatus(`Drawing ${lineMarkups.length} lines and ${textMarkups.length} labels...`);

    try {
        // Add markups in batches to avoid overwhelming the API
        const batchSize = 50;
        
        // Check for plural methods, fallback to singular if needed
        const addLines = TC_API.markup.addLineMarkups ? 
                        TC_API.markup.addLineMarkups.bind(TC_API.markup) : 
                        async (mks) => { for(const m of mks) await TC_API.markup.addLineMarkup(m); };
        
        const addTexts = TC_API.markup.addTextMarkups ? 
                        TC_API.markup.addTextMarkups.bind(TC_API.markup) : 
                        async (mks) => { for(const m of mks) await TC_API.markup.addTextMarkup(m); };

        for (let i = 0; i < lineMarkups.length; i += batchSize) {
            await addLines(lineMarkups.slice(i, i + batchSize));
        }
        for (let i = 0; i < textMarkups.length; i += batchSize) {
            await addTexts(textMarkups.slice(i, i + batchSize));
        }
        updateStatus("Drawing complete.");
    } catch (e) {
        console.error("Error drawing markups:", e);
        updateStatus("Error drawing markups. Check console for details.");
    }
}

function processAlignment(align, interval, swap) {
    const lines = [];
    const texts = [];
    const points = [];

    // 1. Parse Horizontal Geometry
    const coordGeom = align.node.getElementsByTagName('CoordGeom')[0];
    if (!coordGeom) return { lines, texts };

    const children = coordGeom.children;
    for (const child of children) {
        if (child.tagName === 'Line') {
            const startStr = child.getElementsByTagName('Start')[0].textContent.trim();
            const endStr = child.getElementsByTagName('End')[0].textContent.trim();
            const staStart = parseFloat(child.getAttribute('staStart'));
            
            const start = parseCoord(startStr, swap);
            const end = parseCoord(endStr, swap);
            
            points.push({ x: start.x, y: start.y, sta: staStart });
            points.push({ x: end.x, y: end.y, sta: staStart + parseFloat(child.getAttribute('length')) });

        } else if (child.tagName === 'Curve') {
            const startStr = child.getElementsByTagName('Start')[0].textContent.trim();
            const centerStr = child.getElementsByTagName('Center')[0].textContent.trim();
            const endStr = child.getElementsByTagName('End')[0].textContent.trim();
            const staStart = parseFloat(child.getAttribute('staStart'));
            const length = parseFloat(child.getAttribute('length'));
            const radius = parseFloat(child.getAttribute('radius'));
            const rot = child.getAttribute('rot'); // 'cw' or 'ccw'

            const start = parseCoord(startStr, swap);
            const center = parseCoord(centerStr, swap);
            const end = parseCoord(endStr, swap);

            // Interpolate points on arc
            const segments = Math.max(2, Math.ceil(length / 5)); // Point every 5m
            const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
            let endAngle = Math.atan2(end.y - center.y, end.x - center.x);

            // Adjust endAngle based on rotation
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

    // 2. Parse Vertical Geometry
    const pvis = [];
    if (align.profile) {
        const pviNodes = align.profile.getElementsByTagName('PVI');
        for (let i = 0; i < pviNodes.length; i++) {
            const parts = pviNodes[i].textContent.trim().split(/\s+/);
            pvis.push({ sta: parseFloat(parts[0]), elev: parseFloat(parts[1]) });
        }
    }

    function getElevation(sta) {
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
    }

    // 3. Create Markups
    // Convert points to TC Markups (Z is Up, coordinates in mm)
    // Note: LandXML is usually meters, TC is mm.
    const toMM = 1000;

    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i+1];
        
        // Skip tiny segments
        if (Math.abs(p1.x - p2.x) < 0.001 && Math.abs(p1.y - p2.y) < 0.001) continue;

        lines.push({
            color: { r: 255, g: 255, b: 0, a: 1 }, // Yellow
            start: { 
                positionX: p1.x * toMM, 
                positionY: p1.y * toMM, 
                positionZ: getElevation(p1.sta) * toMM 
            },
            end: { 
                positionX: p2.x * toMM, 
                positionY: p2.y * toMM, 
                positionZ: getElevation(p2.sta) * toMM 
            }
        });
    }

    // Stationing labels
    if (points.length > 0) {
        const startSta = points[0].sta;
        const endSta = points[points.length - 1].sta;
        
        for (let s = Math.ceil(startSta / interval) * interval; s <= endSta; s += interval) {
            // Find coordinates for station s
            const p = interpolateHorizontal(points, s);
            if (p) {
                const elev = getElevation(s);
                const pos = {
                    positionX: p.x * toMM,
                    positionY: p.y * toMM,
                    positionZ: elev * toMM
                };

                // Add text markup
                texts.push({
                    text: `KM ${ (s/1000).toFixed(3) }`,
                    color: { r: 0, g: 255, b: 255, a: 1 }, // Cyan
                    start: pos,
                    end: { ...pos, positionZ: (elev + 2) * toMM } // Offset text slightly up
                });

                // Add tick mark (cross line)
                // Find direction to make tick perpendicular
                const pNext = interpolateHorizontal(points, s + 1);
                if (pNext) {
                    const dx = pNext.x - p.x;
                    const dy = pNext.y - p.y;
                    const len = Math.sqrt(dx*dx + dy*dy);
                    const nx = -dy / len;
                    const ny = dx / len;
                    const tickLen = 2; // 2m tick

                    lines.push({
                        color: { r: 0, g: 255, b: 255, a: 1 },
                        start: { 
                            positionX: (p.x - nx * tickLen) * toMM, 
                            positionY: (p.y - ny * tickLen) * toMM, 
                            positionZ: elev * toMM 
                        },
                        end: { 
                            positionX: (p.x + nx * tickLen) * toMM, 
                            positionY: (p.y + ny * tickLen) * toMM, 
                            positionZ: elev * toMM 
                        }
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

// Start
initTC();
