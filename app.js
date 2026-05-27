let viewer = null;
let alignment = [];
let stations = [];

// INIT Trimble
TrimbleConnectWorkspace.connect(window.parent, (api) => {
    viewer = api.viewer;
    log("Connected to Trimble!");
});

// LOG
function log(msg) {
    document.getElementById("log").innerText += msg + "\n";
}

// ===============================
// LOAD LANDXML (REAL PARSER 3D)
// ===============================
function loadXML() {

    const file = document.getElementById("fileInput").files[0];
    const reader = new FileReader();

    reader.onload = function (e) {
        alignment = parseLandXML(e.target.result);
        log("LandXML loaded: " + alignment.length + " segments");
    };

    reader.readAsText(file);
}

// ===============================
// PARSE LANDXML (PntList3D)
// ===============================
function parseLandXML(text) {

    const parser = new DOMParser();
    const xml = parser.parseFromString(text, "text/xml");

    const coords = xml.getElementsByTagName("CoordGeom")[0];
    const lines = coords.getElementsByTagName("Line");

    const segments = [];

    for (let line of lines) {

        const pntList = line.getElementsByTagName("PntList3D")[0];
        if (!pntList) continue;

        const values = pntList.textContent.trim().split(/\s+/);

        for (let i = 0; i < values.length - 5; i += 3) {

            const p1 = {
                x: parseFloat(values[i + 1]),
                y: parseFloat(values[i]),
                z: parseFloat(values[i + 2])
            };

            const p2 = {
                x: parseFloat(values[i + 4]),
                y: parseFloat(values[i + 3]),
                z: parseFloat(values[i + 5])
            };

            segments.push({
                p1,
                p2,
                length: distance3D(p1, p2)
            });
        }
    }

    return segments;
}

// ===============================
// DISTANȚĂ 3D
// ===============================
function distance3D(a, b) {
    return Math.sqrt(
        Math.pow(b.x - a.x, 2) +
        Math.pow(b.y - a.y, 2) +
        Math.pow(b.z - a.z, 2)
    );
}

// ===============================
// GENERARE PICHEȚI (REAL 3D)
// ===============================
function generateStations(step = 20) {

    stations = [];
    let chainage = 0;

    for (let seg of alignment) {

        let dist = 0;

        while (dist <= seg.length) {

            const t = dist / seg.length;

            const x = seg.p1.x + (seg.p2.x - seg.p1.x) * t;
            const y = seg.p1.y + (seg.p2.y - seg.p1.y) * t;
            const z = seg.p1.z + (seg.p2.z - seg.p1.z) * t;

            stations.push({
                x, y, z,
                chainage: chainage + dist
            });

            dist += step;
        }

        chainage += seg.length;
    }

    // slope real
    for (let i = 1; i < stations.length; i++) {

        const dz = stations[i].z - stations[i - 1].z;
        const dx = stations[i].chainage - stations[i - 1].chainage;

        stations[i].slope = (dz / dx) * 100;
    }

    log("Stations: " + stations.length);
}

// ===============================
// FORMAT KM
// ===============================
function formatChainage(ch) {

    const km = Math.floor(ch / 1000);
    const m = Math.floor(ch % 1000);

    return `km ${km}+${m.toString().padStart(3, '0')}`;
}

// ===============================
// DESEN AX
// ===============================
function drawAlignment() {

    const lines = alignment.map(seg => ({
        start: [seg.p1.x, seg.p1.y, seg.p1.z],
        end: [seg.p2.x, seg.p2.y, seg.p2.z]
    }));

    viewer.addObjectOverlay({
        id: "alignment",
        lines: lines
    });

    log("Alignment drawn");
}

// ===============================
// DESEN PICHEȚI + TEXT + PANTĂ
// ===============================
function drawStations() {

    generateStations(20);

    // puncte
    viewer.addObjectOverlay({
        id: "stations_points",
        points: stations.map(s => ({
            position: [s.x, s.y, s.z],
            color: { r: 0, g: 0, b: 255 }
        }))
    });

    // KM TEXT
    viewer.addObjectOverlay({
        id: "stations_labels",
        texts: stations.map(s => ({
            position: [s.x, s.y, s.z + 1],
            text: formatChainage(s.chainage),
            color: { r: 0, g: 0, b: 0 }
        }))
    });

    // SLOPE TEXT + COLOR
    viewer.addObjectOverlay({
        id: "slope_labels",
        texts: stations.map(s => ({
            position: [s.x, s.y, s.z + 2],
            text: s.slope ? s.slope.toFixed(2) + "%" : "",
            color: s.slope >= 0
                ? { r: 0, g: 150, b: 0 }
                : { r: 200, g: 0, b: 0 }
        }))
    });

    log("Stations drawn with slopes");
}