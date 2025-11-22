// script.js — Real-time Earthquake Dashboard (USGS)
const STATUS = document.getElementById("status");
const timeWindowEl = document.getElementById("timeWindow");
const minMagEl = document.getElementById("minMag");
const regionEl = document.getElementById("region");
const applyBtn = document.getElementById("applyBtn");
const refreshBtn = document.getElementById("refreshBtn");
const autoRefreshEl = document.getElementById("autoRefresh");

const eventsTableBody = document.querySelector("#eventsTable tbody");

let lineChart=null, barChart=null, pieChart=null, map=null, markersLayer=null;
let autoTimer = null;
const AUTO_INTERVAL = 30 * 1000; // 30 seconds

// Mapping: timeWindow => USGS feed
function getFeedUrl(windowKey){
  switch(windowKey){
    case "hour": return "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";
    case "day": return "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";
    case "week": default: return "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson";
  }
}

// Fetch geojson and return features array
async function fetchEarthquakes(){
  const feed = getFeedUrl(timeWindowEl.value);
  STATUS.textContent = `Fetching live data from USGS (${timeWindowEl.value})...`;
  try{
    const res = await fetch(feed);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const geo = await res.json();
    const features = geo.features || [];
    STATUS.textContent = `Fetched ${features.length} events — ${new Date().toLocaleTimeString()}`;
    return features;
  } catch(err){
    console.error("Fetch error", err);
    STATUS.textContent = `Failed to fetch live data: ${err.message}`;
    return [];
  }
}

// Normalize features → simpler records
function normalizeFeatures(features){
  return features.map(f=>{
    const props = f.properties || {};
    const coords = f.geometry && f.geometry.coordinates ? f.geometry.coordinates : [null,null,null];
    return {
      id: f.id,
      time: props.time,
      mag: props.mag,
      place: props.place,
      url: props.url,
      depth: coords[2],
      lon: coords[0],
      lat: coords[1]
    };
  }).filter(r => r.mag != null && r.time != null);
}

// Filter records by min magnitude & region
function filterRecords(records){
  const minMag = parseFloat(minMagEl.value) || 0;
  const regionText = (regionEl.value || "").trim().toLowerCase();

  return records.filter(r=>{
    if(r.mag < minMag) return false;

    if(regionText){
      return (r.place && r.place.toLowerCase().includes(regionText));
    }
    return true;
  });
}

// Line chart: events over time
function buildLineChart(records){
  const grouped = {};
  records.forEach(r=>{
    const d = new Date(r.time);
    const label =
      timeWindowEl.value === "hour" ? `${d.getUTCHours()}:00` :
      timeWindowEl.value === "day" ? `${d.getUTCMonth()+1}/${d.getUTCDate()} ${d.getUTCHours()}:00` :
      `${d.getUTCMonth()+1}/${d.getUTCDate()}`;
    grouped[label] = (grouped[label] || 0) + 1;
  });

  const labels = Object.keys(grouped).sort();
  const data = labels.map(l=>grouped[l]);

  if(lineChart) lineChart.destroy();
  const ctx = document.getElementById("lineChart").getContext("2d");

  lineChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{ label: "Events count", data, borderColor:"rgba(75,192,192,1)", fill:false }]},
    options: { responsive:true, plugins:{ title:{ display:true, text:"Events over time" }}}
  });
}

// Bar chart: magnitude distribution
function buildBarChart(records){
  const buckets = { "0-1":0,"1-2":0,"2-3":0,"3-4":0,"4-5":0,"5+":0 };

  records.forEach(r=>{
    const m = r.mag;
    if(m < 1) buckets["0-1"]++;
    else if(m < 2) buckets["1-2"]++;
    else if(m < 3) buckets["2-3"]++;
    else if(m < 4) buckets["3-4"]++;
    else if(m < 5) buckets["4-5"]++;
    else buckets["5+"]++;
  });

  const labels = Object.keys(buckets);
  const data = labels.map(l=>buckets[l]);

  if(barChart) barChart.destroy();
  const ctx = document.getElementById("barChart").getContext("2d");

  barChart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets:[{ label:"Count", data, backgroundColor:"rgba(255,159,64,0.7)" }]},
    options:{ responsive:true, plugins:{ title:{ display:true, text:"Magnitude distribution" }}}
  });
}

// Pie chart: depth categories
function buildPieChart(records){
  const cats = { shallow:0, intermediate:0, deep:0 };

  records.forEach(r=>{
    const d = r.depth || 0;
    if(d < 70) cats.shallow++;
    else if(d < 300) cats.intermediate++;
    else cats.deep++;
  });

  const labels = ["Shallow (0-70km)","Intermediate (70-300km)","Deep (300+ km)"];
  const data = [cats.shallow, cats.intermediate, cats.deep];

  if(pieChart) pieChart.destroy();
  const ctx = document.getElementById("pieChart").getContext("2d");

  pieChart = new Chart(ctx, {
    type: "doughnut",
    data: { labels, datasets:[{ data, backgroundColor:["#36A2EB","#FFCE56","#FF6384"] }]},
    options:{ responsive:true, plugins:{ title:{ display:true, text:"Depth categories" }}}
  });
}

// Table (latest 200 events)
function populateTable(records){
  eventsTableBody.innerHTML = "";
  records.slice(0,200).forEach(r=>{
    const tr = document.createElement("tr");
    const dt = new Date(r.time).toISOString().replace("T"," ").replace("Z","");

    tr.innerHTML = `
      <td><a href="${r.url}" target="_blank">${dt}</a></td>
      <td>${r.mag.toFixed(1)}</td>
      <td>${(r.depth||0).toFixed(1)}</td>
      <td>${r.place || ""}</td>
    `;

    eventsTableBody.appendChild(tr);
  });
}

// Map setup
function initMap(){
  if(map) return;

  map = L.map('map').setView([20,0], 2);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap'
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

// Update markers on map
function updateMap(records){
  if(!map) initMap();
  markersLayer.clearLayers();

  records.slice(0,500).forEach(r=>{
    if(r.lat==null || r.lon==null) return;

    const radius = Math.max(4000, (r.mag || 0) * 40000);
    const color = r.mag >= 5 ? "#ff4d4f" :
                  r.mag >= 4 ? "#ff9f40" :
                                "#36a2eb";

    const circle = L.circle([r.lat, r.lon], {
      radius,
      color,
      fillColor: color,
      fillOpacity: 0.5
    });

    circle.bindPopup(`
      <strong>Mag ${r.mag}</strong><br>
      ${r.place || ""}<br>
      Depth: ${(r.depth||0).toFixed(1)} km<br>
      ${new Date(r.time).toUTCString()}
    `);

    markersLayer.addLayer(circle);
  });
}

// Main — fetch + update everything
async function updateAll(){
  const raw = await fetchEarthquakes();
  const normalized = normalizeFeatures(raw);
  const filtered = filterRecords(normalized);

  filtered.sort((a,b)=> b.time - a.time);

  buildLineChart(filtered);
  buildBarChart(filtered);
  buildPieChart(filtered);
  populateTable(filtered);
  updateMap(filtered);
}

// Button events
applyBtn.addEventListener("click", async (e)=>{
  e.preventDefault();
  await updateAll();
});

refreshBtn.addEventListener("click", async (e)=>{
  e.preventDefault();
  await updateAll();
});

// Auto-refresh every 30 seconds
function startAutoRefresh(){
  if(autoTimer) clearInterval(autoTimer);
  if(autoRefreshEl.checked){
    autoTimer = setInterval(updateAll, AUTO_INTERVAL);
  }
}
autoRefreshEl.addEventListener("change", startAutoRefresh);

// On page load
window.addEventListener("load", async ()=>{
  initMap();
  await updateAll();
  startAutoRefresh();
});
