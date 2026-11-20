(function geoElevationModule() {
    'use strict';

    const storageKey = 'ft_geo_tracks_v1';
    const instances = new WeakMap();
    const sessionTracks = Object.create(null);
    let savedTracks = {};

    try {
        const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
        if (value && typeof value === 'object') savedTracks = value;
    } catch (error) {
        savedTracks = {};
    }

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const numberFormat = (value, places = 0) =>
        Number(value).toLocaleString('de-AT', {
            minimumFractionDigits: places,
            maximumFractionDigits: places
        });

    function normalizePoint(raw) {
        if (!raw) return null;
        const latitude = Number(Array.isArray(raw) ? raw[0] : raw.lat ?? raw.latitude);
        const longitude = Number(Array.isArray(raw) ? raw[1] :
            raw.lon ?? raw.lng ?? raw.longitude);
        const rawHeight = Array.isArray(raw) ? raw[2] :
            raw.ele ?? raw.alt ?? raw.altitude ?? raw.elevation ?? raw.height;
        const height = rawHeight === null || rawHeight === undefined || rawHeight === ''
            ? null : Number(rawHeight);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
            Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

        return {
            lat: latitude,
            lon: longitude,
            ele: Number.isFinite(height) ? height : null
        };
    }

    function segmentDistance(a, b) {
        const r = Math.PI / 180;
        const x = (b.lat - a.lat) * r;
        const y = (b.lon - a.lon) * r;
        const h = Math.sin(x / 2) ** 2 +
            Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(y / 2) ** 2;
        return 12742000 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
    }

    function prepareTrack(raw) {
        if (!Array.isArray(raw)) return [];
        const items = raw.map(normalizePoint).filter(Boolean);
        if (items.length < 2) return [];
        let accumulated = 0;
        return items.map((point, index) => {
            if (index > 0) accumulated += segmentDistance(items[index - 1], point);
            return { ...point, meters: accumulated };
        });
    }

    // Nur eine Vorschau! Echte OSM-Karte, aber demonstrative Route/Höhenwerte.
    function sampleTrack() {
        const shape = [
            [-.015, .004],[-.011,.008],[-.007,.005],[-.006,-.001],
            [-.001,-.004],[.004,.002],[.009,.004],[.013,.000],
            [.011,-.007],[.005,-.011],[-.002,-.009],[-.010,-.006]
        ];
        const sample = [];
        for (let i = 0; i < shape.length - 1; i++) {
            for (let step = 0; step < 9; step++) {
                const t = step / 9;
                const progress = (i + t) / (shape.length - 1);
                const x = shape[i][0] * (1 - t) + shape[i + 1][0] * t;
                const y = shape[i][1] * (1 - t) + shape[i + 1][1] * t;
                const top = 360 * Math.exp(-Math.pow((progress - .38) / .19, 2));
                const secondTop = 155 * Math.exp(-Math.pow((progress - .78) / .12, 2));

                sample.push({
                    lat: 46.969 + y,
                    lon: 11.010 + x,
                    ele: Math.round(1390 + top + secondTop + 28 * Math.sin(progress * 19))
                });
            }
        }
        const end = shape[shape.length - 1];
        sample.push({ lat:46.969 + end[1], lon:11.010 + end[0], ele:1420 });
        return prepareTrack(sample);
    }

    function getTrack(activity) {
        const id = String(activity?.id || '');
        const fileTrack = sessionTracks[id] || savedTracks[id];
        if (Array.isArray(fileTrack)) {
            const points = prepareTrack(fileTrack);
            if (points.length) return {points, source:'GPX'};
        }
        const gps = activity?.gps?.points ?? activity?.gps?.track ?? activity?.gps;
        const points = prepareTrack(gps);
        if (points.length) return {points, source:'GPS'};
        if (activity?.demo) return {points:sampleTrack(), source:'Demo'};
        return {points:[], source:'Leer'};
    }

    function pointAt(points, ratio) {
        if (!points.length) return null;
        const length = points[points.length - 1].meters;
        const meters = length * clamp(ratio, 0, 1);
        let nextIndex = points.findIndex(p => p.meters >= meters);
        if (nextIndex < 0) nextIndex = points.length - 1;
        if (nextIndex === 0) return {...points[0], index:0};

        const prev = points[nextIndex - 1];
        const next = points[nextIndex];
        const range = next.meters - prev.meters;
        const t = range > 0 ? clamp((meters - prev.meters) / range, 0, 1) : 0;
        let altitude = null;
        if (prev.ele !== null && next.ele !== null) {
            altitude = prev.ele + (next.ele - prev.ele) * t;
        } else {
            altitude = prev.ele ?? next.ele;
        }
        return {
            lat: prev.lat + (next.lat - prev.lat) * t,
            lon: prev.lon + (next.lon - prev.lon) * t,
            meters, ele: altitude, index: nextIndex
        };
    }

    function parseGPX(rawXML) {
        if (rawXML.length > 6 * 1024 * 1024) {
            throw new Error('Die GPX-Datei darf höchstens 6 MB groß sein.');
        }
        const xml = new DOMParser().parseFromString(rawXML, 'application/xml');
        if (xml.getElementsByTagName('parsererror').length) {
            throw new Error('Ungültige GPX-Datei.');
        }

        const nodes = [...xml.getElementsByTagNameNS('*', 'trkpt')];
        if (!nodes.length) nodes.push(...xml.getElementsByTagNameNS('*', 'rtept'));

        const stride = Math.max(1, Math.ceil(nodes.length / 2800));
        const points = [];
        function parseNode(node) {
            const ele = [...node.children].find(child => child.localName === 'ele');
            return normalizePoint({
                lat: node.getAttribute('lat'),
                lon: node.getAttribute('lon'),
                ele: ele?.textContent ?? null
            });
        }

        for (let i = 0; i < nodes.length; i += stride) {
            const p = parseNode(nodes[i]);
            if (p) points.push(p);
        }
        if (nodes.length > 1 && (nodes.length - 1) % stride) {
            const last = parseNode(nodes[nodes.length - 1]);
            if (last) points.push(last);
        }
        if (points.length < 2) throw new Error('Mindestens zwei GPS-Punkte erforderlich.');
        return points;
    }

    function destroy(container) {
        if (!container) return;
        const instance = instances.get(container);
        if (!instance) return;
        instance.destroyed = true;
        if (instance.animation) cancelAnimationFrame(instance.animation);
        instance.observer?.disconnect();
        if (instance.map) instance.map.remove();
        instances.delete(container);
    }

    function render(container, activity) {
        if (!container || !activity) return;
        destroy(container);

        const {points, source} = getTrack(activity);
        const isDemo = source === 'Demo';
        const totalDistance = points.at(-1)?.meters || 0;
        const elevations = points.filter(point => point.ele !== null);
        const elevationAvailable = elevations.length >= 2;

        const state = {
            container, activity, points, totalDistance,
            map:null,marker:null,covered:null,observer:null,
            animation:0, ratio:0, destroyed:false
        };
        instances.set(container, state);

        container.innerHTML = `
            <div class="geo-explorer">
                <section class="geo-pane">
                    <div class="geo-pane-head">
                        <h3 class="geo-pane-title">🗺 Interaktive Karte</h3>
                        <span class="geo-chip ${isDemo ? 'demo' : ''}">
                            ${isDemo ? '● DEMO' : source === 'GPX' ? '● GPX' : source === 'GPS' ? '● GPS' : '● Ohne GPS'}
                        </span>
                    </div>
                    <div class="geo-mapbox" data-geo-map></div>
                    <p class="geo-pane-note">
                        ${isDemo
                            ? 'Echte OpenStreetMap-Karte, aber simulierte Strecke und Höhenwerte. Keine echte Aufzeichnung.'
                            : points.length ? 'Der Marker folgt dem ausgewählten Punkt im Höhenprofil.'
                                : 'Für dieses Training liegen noch keine GPS-Koordinaten vor.'}
                    </p>
                </section>
                <section class="geo-pane">
                    <div class="geo-pane-head">
                        <h3 class="geo-pane-title">⛰ Höhenprofil</h3>
                        <span class="geo-chip">↔ Mit Karte verbunden</span>
                    </div>
                    <div class="geo-stats">
                        <div class="geo-stat"><small>Strecke</small><strong data-geo-distance>--</strong></div>
                        <div class="geo-stat"><small>Höhe</small><strong data-geo-height>--</strong></div>
                        <div class="geo-stat"><small>Position</small><strong data-geo-position>0 %</strong></div>
                    </div>
                    <div class="geo-profile-wrap">
                        <canvas class="geo-profile-canvas" data-geo-plot
                            role="img" tabindex="0"
                            aria-label="Höhenverlauf. Mit Maus oder Finger entlangfahren">
                        </canvas>
                    </div>
                    <input class="geo-profile-range" type="range" data-geo-slider
                        min="0" max="1000" value="0" aria-label="Position entlang der Route" />
                    <div class="geo-explorer-controls">
                        <button class="geo-button" type="button" data-geo-play>▶ Route abspielen</button>
                        <button class="geo-button" type="button" data-geo-reset>↶ Zum Start</button>
                        <button class="geo-button" type="button" data-geo-import>⇪ GPX laden</button>
                        <input class="geo-file-input" data-geo-file type="file"
                            accept=".gpx,application/gpx+xml,application/xml,text/xml">
                    </div>
                    <p class="geo-hint">${isDemo
                        ? '<strong>Demodaten:</strong> Route und Höhen sind nur eine Veranschaulichung.'
                        : source === 'GPX' ? 'Die GPX-Datei wird lokal im Browser verarbeitet.'
                            : 'Du kannst eine GPX-Datei mit GPS-Koordinaten und Höhenpunkten laden.'}</p>
                    <p class="geo-import-status" data-geo-message role="status" aria-live="polite"></p>
                </section>
            </div>
        `;

        const $ = selector => container.querySelector(selector);
        const mapHolder = $('[data-geo-map]');
        const canvas = $('[data-geo-plot]');
        const slider = $('[data-geo-slider]');
        const play = $('[data-geo-play]');
        const reset = $('[data-geo-reset]');
        const upload = $('[data-geo-import]');
        const input = $('[data-geo-file]');
        const message = $('[data-geo-message]');
        const distanceLabel = $('[data-geo-distance]');
        const heightLabel = $('[data-geo-height]');
        const positionLabel = $('[data-geo-position]');

        if (typeof window.L === 'undefined') {
            mapHolder.innerHTML = '<div class="geo-map-error">Karte nicht geladen. Bitte Internetverbindung prüfen. <a href="https://www.openstreetmap.org/" target="_blank" rel="noopener">OpenStreetMap öffnen</a></div>';
        } else {
            const map = L.map(mapHolder, {
                scrollWheelZoom:false, zoomControl:true, attributionControl:true
            });
            state.map = map;

            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom:19,
                attribution:'&copy; <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
            }).addTo(map);

            if (points.length > 1) {
                const route = points.map(point => [point.lat, point.lon]);
                L.polyline(route, {color:'#112a38', weight:9, opacity:.77}).addTo(map);
                L.polyline(route, {color:'#ff875c', weight:5, opacity:.94}).addTo(map);
                state.covered = L.polyline([route[0]], {
                    color:'#48e2b8', weight:6, lineCap:'round'
                }).addTo(map);
                state.marker = L.circleMarker(route[0], {
                    radius:10, color:'#fff', weight:3,
                    fillColor:'#ff7048', fillOpacity:1
                }).addTo(map);
                L.circleMarker(route[0], {
                    radius:5,color:'#fff',weight:2,fillColor:'#3bddab',fillOpacity:1
                }).addTo(map);
                L.circleMarker(route.at(-1), {
                    radius:5,color:'#fff',weight:2,fillColor:'#f9b15a',fillOpacity:1
                }).addTo(map);

                map.fitBounds(L.latLngBounds(route).pad(.18), {
                    padding:[20,20],maxZoom:14
                });
            } else {
                map.setView([47.5,13.4],6);
            }
            requestAnimationFrame(() => {
                if (!state.destroyed) map.invalidateSize(false);
            });
        }

        function updateState() {
            const p = pointAt(points, state.ratio);
            distanceLabel.textContent = p ? numberFormat(p.meters/1000,2)+' km' : '--';
            heightLabel.textContent = p?.ele === null || !p ? '--' :
                numberFormat(p.ele)+' m';
            positionLabel.textContent = numberFormat(state.ratio*100)+' %';
            slider.value = Math.round(state.ratio*1000);
            slider.setAttribute('aria-valuetext',
                (p?.ele == null ? 'Höhe unbekannt' : numberFormat(p.ele)+' Meter')+
                ', '+(p ? numberFormat(p.meters/1000,2)+' Kilometer' : 'ohne Strecke'));

            if (state.map && state.marker && p) {
                state.marker.setLatLng([p.lat,p.lon]);
                const done = points.slice(0,p.index).map(q=>[q.lat,q.lon]);
                done.push([p.lat,p.lon]);
                state.covered.setLatLngs(done);
            }
        }

        function drawPlot() {
            const rect = canvas.getBoundingClientRect();
            const width = Math.max(220,Math.round(rect.width));
            const height = Math.max(205,Math.round(rect.height));
            const density = Math.min(window.devicePixelRatio || 1,2);

            canvas.width = Math.round(width*density);
            canvas.height = Math.round(height*density);

            const ctx = canvas.getContext('2d');
            ctx.setTransform(density,0,0,density,0,0);
            ctx.clearRect(0,0,width,height);

            const left = width < 330 ? 54 : 62;
            const right = 14, top=19, bottom=44;
            const plotWidth = width-left-right;
            const plotHeight = height-top-bottom;
            ctx.font='600 13px Arial';
            ctx.fillStyle='#b4c9d7';

            if (!elevationAvailable) {
                ctx.textAlign='center';
                ctx.fillText(points.length
                    ? 'Keine Höhenmesspunkte vorhanden'
                    : 'Noch keine GPS- und Höhendaten',width/2,height/2);
                ctx.font='12px Arial';
                ctx.fillText('GPX-Datei mit Höhe (ele) laden',width/2,height/2+24);
                return;
            }

            const minValue = Math.min(...elevations.map(p=>p.ele));
            const maxValue = Math.max(...elevations.map(p=>p.ele));
            const min = Math.floor((minValue-25)/50)*50;
            const max = Math.max(min+50,Math.ceil((maxValue+25)/50)*50);
            const x = p => left+plotWidth*(totalDistance ? p.meters/totalDistance : 0);
            const y = ele => top+(max-ele)/(max-min)*plotHeight;

            ctx.textBaseline='middle';
            for (let j=0; j<=4; j++) {
                const gy=top+j*plotHeight/4;
                ctx.strokeStyle='#375167';
                ctx.lineWidth=1;ctx.beginPath();
                ctx.moveTo(left,gy);ctx.lineTo(width-right,gy);ctx.stroke();
                ctx.textAlign='right';ctx.fillStyle='#d2e1ef';
                ctx.fillText(numberFormat(max-(max-min)*j/4),left-9,gy);
            }

            ctx.textAlign='center';ctx.textBaseline='alphabetic';
            for(let j=0;j<=4;j++){
                const gx=left+j*plotWidth/4;
                ctx.fillText(numberFormat(totalDistance*j/4000,1)+' km',gx,height-14);
            }

            const gradient=ctx.createLinearGradient(0,top,0,top+plotHeight);
            gradient.addColorStop(0,'rgba(255,150,96,.35)');
            gradient.addColorStop(1,'rgba(255,150,96,.02)');
            ctx.beginPath();
            ctx.moveTo(x(elevations[0]),top+plotHeight);
            elevations.forEach(point=>ctx.lineTo(x(point),y(point.ele)));
            ctx.lineTo(x(elevations.at(-1)),top+plotHeight);
            ctx.closePath();ctx.fillStyle=gradient;ctx.fill();

            ctx.beginPath();
            elevations.forEach((point,index)=>{
                if(index===0)ctx.moveTo(x(point),y(point.ele));
                else ctx.lineTo(x(point),y(point.ele));
            });
            ctx.lineCap='round';ctx.lineJoin='round';
            ctx.lineWidth=3;ctx.strokeStyle='#ff9870';ctx.stroke();

            const selected=pointAt(points,state.ratio);
            if(!selected)return;
            const gx=left+plotWidth*state.ratio;
            const gy=selected.ele!=null ? y(selected.ele) : top+plotHeight/2;
            ctx.strokeStyle='#7ef2d6';ctx.lineWidth=1.4;
            ctx.setLineDash([5,5]);ctx.beginPath();
            ctx.moveTo(gx,top);ctx.lineTo(gx,top+plotHeight);ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();ctx.arc(gx,gy,6.5,0,Math.PI*2);
            ctx.fillStyle='#ff704e';ctx.fill();
            ctx.strokeStyle='#fff';ctx.lineWidth=3;ctx.stroke();
        }

        function move(ratio) {
            state.ratio=clamp(ratio,0,1);
            updateState();
            drawPlot();
        }

        function pointerRatio(event) {
            const rect=canvas.getBoundingClientRect();
            const left=rect.width<330 ? 54 : 62;
            const usable=Math.max(1,rect.width-left-14);
            return clamp((event.clientX-rect.left-left)/usable,0,1);
        }

        canvas.addEventListener('pointermove',event=>{
            if(event.pointerType==='mouse' || canvas.hasPointerCapture(event.pointerId)) {
                move(pointerRatio(event));
            }
        });
        canvas.addEventListener('pointerdown',event=>{
            canvas.setPointerCapture(event.pointerId);
            move(pointerRatio(event));
        });
        canvas.addEventListener('keydown',event=>{
            const delta=event.key==='ArrowRight'? .01 :
                event.key==='ArrowLeft'? -.01 : 0;
            if(delta) {event.preventDefault();move(state.ratio+delta);}
        });
        slider.addEventListener('input',event=>move(Number(event.target.value)/1000));

        function stopAnimation(){
            if(state.animation) cancelAnimationFrame(state.animation);
            state.animation=0;
            play.textContent='▶ Route abspielen';
        }
        play.addEventListener('click',()=>{
            if(state.animation){stopAnimation();return;}
            if(points.length<2)return;
            const started=performance.now();
            const startRatio=state.ratio>=1?0:state.ratio;
            const step=now=>{
                if(state.destroyed) return;
                const progress=startRatio+(now-started)/9000;
                move(Math.min(1,progress));
                if(progress>=1){stopAnimation();return;}
                state.animation=requestAnimationFrame(step);
            };
            play.textContent='Ⅱ Pause';
            state.animation=requestAnimationFrame(step);
        });
        reset.addEventListener('click',()=>{stopAnimation();move(0);});
        upload.addEventListener('click',()=>input.click());

        input.addEventListener('change',async()=>{
            const localFile=input.files?.[0];
            if(!localFile)return;
            message.textContent='GPX-Datei wird eingelesen …';
            try {
                const gpsPoints=parseGPX(await localFile.text());
                const id=String(activity.id);
                sessionTracks[id]=gpsPoints;
                let persistent=false;
                try {
                    savedTracks[id]=gpsPoints;
                    localStorage.setItem(storageKey,JSON.stringify(savedTracks));
                    persistent=true;
                } catch(error) {
                    delete savedTracks[id];
                }
                render(container,activity);
                const element=container.querySelector('[data-geo-message]');
                if(element) element.textContent=persistent ?
                    '✓ GPX-Strecke wurde lokal gespeichert.' :
                    '✓ GPX geladen, aber Browser-Speicher voll: nur bis zum Neuladen verfügbar.';
            } catch(error) {
                message.textContent='Import fehlgeschlagen: '+error.message;
            }
        });

        if(typeof ResizeObserver!=='undefined'){
            state.observer=new ResizeObserver(()=>{
                if(state.destroyed)return;
                drawPlot();
                if(state.map) state.map.invalidateSize(false);
            });
            state.observer.observe(container);
        }

        updateState();
        requestAnimationFrame(()=>{if(!state.destroyed)drawPlot();});
    }

    function refresh(container) {
        const instance=instances.get(container);
        if(!instance || instance.destroyed)return;
        if(instance.map) instance.map.invalidateSize(false);
        const slider=container.querySelector('[data-geo-slider]');
        if(slider)slider.dispatchEvent(new Event('input'));
    }

    window.geoElevationExplorer={
        render, destroy, refresh,
        hasTrack:activity=>getTrack(activity).points.length>1
    };
})();