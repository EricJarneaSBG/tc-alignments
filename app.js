let API = null;

async function init() {
  API = await TrimbleConnectWorkspace.connect(window.parent, (event, data) => {
    console.log(event, data);
  });

  document.getElementById("loadBtn").addEventListener("click", loadLandXML);

  setStatus("Connected to Trimble Connect");
}

function setStatus(text) {
  document.getElementById("status").innerText = text;
}

async function loadLandXML() {
  const fileInput = document.getElementById("fileInput");

  if (!fileInput.files.length) {
    alert("Select a LandXML file first.");
    return;
  }

  const file = fileInput.files[0];
  const text = await file.text();

  const parser = new DOMParser();
  const xml = parser.parseFromString(text, "text/xml");

  const alignments = xml.getElementsByTagName("Alignment");

  if (!alignments.length) {
    setStatus("No Alignment found.");
    return;
  }

  const alignment = alignments[0];

  setStatus(`Found alignment: ${alignment.getAttribute("name")}`);

  const coordGeom = alignment.getElementsByTagName("CoordGeom")[0];

  if (!coordGeom) {
    setStatus("No CoordGeom found.");
    return;
  }

  const lines = coordGeom.getElementsByTagName("Line");

  const points = [];

  for (const line of lines) {
    const start = line.getElementsByTagName("Start")[0]?.textContent.trim();
    const end = line.getElementsByTagName("End")[0]?.textContent.trim();

    if (!start || !end) continue;

    const s = start.split(" ").map(Number);
    const e = end.split(" ").map(Number);

    points.push(s);
    points.push(e);
  }

  if (!points.length) {
    setStatus("No geometry points found.");
    return;
  }

  drawStationing(points);
}

async function drawStationing(points) {

  // Remove duplicate points
  const unique = [];
  const map = new Set();

  for (const p of points) {
    const key = p.join(",");

    if (!map.has(key)) {
      map.add(key);
      unique.push(p);
    }
  }

  let station = 0;

  for (let i = 0; i < unique.length; i++) {

    const p = unique[i];

    const x = p[1];
    const y = p[0];
    const z = p[2] || 0;

    const label = `STA ${station.toFixed(0)}`;

    await createTextMarker(x, y, z, label);

    station += 20;
  }

  setStatus("Stationing drawn.");
}

async function createTextMarker(x, y, z, text) {

  // Minimal approach:
  // Use viewpoint markup labels

  const markup = {
    color: "#ff0000",
    start: {
      positionX: x,
      positionY: y,
      positionZ: z
    },
    end: {
      positionX: x,
      positionY: y,
      positionZ: z + 1
    },
    text: text
  };

  try {
    await API.markup.addTextMarkup(markup);
  }
  catch (err) {
    console.error(err);
  }
}

init();