// --- Configuration Rules & Variables ---
         let ruleHardSplit = localStorage.getItem('app_rule_split') || '~';
         let ruleHideBlock = localStorage.getItem('app_rule_hide') || '~h';
         let abortTranslation = false;
         
         // --- Video Mode & Subtitle Variables ---
         let isVideoMode = false;
         let videoSubtitles = [];
         let secondSrtSubtitles = [];
         let activeSrtView = 'primary'; // 'primary' = first SRT, 'secondary' = second SRT
         let showSecondSrtCurrentLine = false;
         let videoPollingFrame = null;
         let currentVideoUrl = null;
         let currentVideoBlob = null; // keep a direct reference so we can reload without an IndexedDB round-trip
         
         // Debounce state variables for rapid pen clicks
         let isJumping = false;
         let targetPlayingState = false;
         
         // --- IndexedDB for Persistent Video & SRT ---
         const dbName = "SentenceRepeaterDB";
         let db;
         let dbOpening = false;
         const dbReadyWaiters = [];
         function openDB(onReady) {
             if (onReady) dbReadyWaiters.push(onReady);

             // Reuse an already-open connection.
             if (db) {
                 if (onReady) {
                     const cb = dbReadyWaiters.pop();
                     if (cb) cb();
                 }
                 return;
             }

             // If an open request is already running, its success/error handler
             // will service every waiter. This avoids losing callbacks during
             // simultaneous video restore/save operations.
             if (dbOpening) return;

             dbOpening = true;
             const dbReq = indexedDB.open(dbName, 1);
             dbReq.onupgradeneeded = (e) => {
                 db = e.target.result;
                 if (!db.objectStoreNames.contains('mediaStore')) {
                     db.createObjectStore('mediaStore');
                 }
             };
             dbReq.onsuccess = (e) => {
                 db = e.target.result;
                 dbOpening = false;
                 db.onclose = () => { db = null; };
                 db.onerror = (event) => {
                     if (event.target && event.target.error) {
                         console.warn('IndexedDB connection error:', event.target.error);
                     }
                 };
                 db.onversionchange = () => {
                     try { db.close(); } catch(e) {}
                     db = null;
                 };

                 const waiters = dbReadyWaiters.splice(0);
                 if (waiters.length) {
                     waiters.forEach(cb => { try { cb(); } catch(e) { console.error(e); } });
                 } else {
                     loadMediaFromDB();
                 }
             };
             dbReq.onerror = (e) => {
                 dbOpening = false;
                 console.error('IndexedDB error:', e.target && e.target.error ? e.target.error : e);
                 dbReadyWaiters.splice(0).forEach(cb => {
                     try { cb(false); } catch(err) { console.error(err); }
                 });
             };
         }
         openDB();
         
         function saveToDB(key, data) {
             const write = () => {
                 if (!db) {
                     console.warn('IndexedDB is unavailable; save skipped.');
                     return;
                 }
                 try {
                     const tx = db.transaction('mediaStore', 'readwrite');
                     const req = tx.objectStore('mediaStore').put(data, key);
                     req.onerror = (e) => {
                         console.error('Storage error:', e.target.error);
                         if (key === 'video') {
                             alert("Video is too large to save to browser storage. It will play now, but won't be saved for next time.");
                         }
                     };
                     tx.onerror = (e) => console.error('Storage transaction error:', e.target.error);
                 } catch (e) {
                     console.error('Transaction error:', e);
                     db = null;
                     openDB(() => saveToDB(key, data));
                 }
             };

             if (db) write();
             else openDB(write);
         }
         
         function loadMediaFromDB() {
             if (!db) {
                 openDB(() => loadMediaFromDB());
                 return;
             }
             let tx;
             try {
                 tx = db.transaction('mediaStore', 'readonly');
             } catch (e) {
                 console.warn('IndexedDB read transaction failed; reopening:', e);
                 db = null;
                 openDB(() => loadMediaFromDB());
                 return;
             }
             tx.onerror = () => {
                 console.warn('IndexedDB media read failed:', tx.error);
             };
             const store = tx.objectStore('mediaStore');

             // Restore the optional second SRT independently of the video.
             const secondSrtReq = store.get('srt2');
             secondSrtReq.onsuccess = () => {
                 if (secondSrtReq.result) {
                     secondSrtSubtitles = parseSRTSubtitles(secondSrtReq.result);
                     updateSecondSrtButtonStates();
                     if (secondSrtSubtitles.length) renderPlaylist();
                 } else {
                     activeSrtView = 'primary';
                     localStorage.setItem('app_srt_view', 'primary');
                     updateSecondSrtButtonStates();
                 }
             };
             
             const videoReq = store.get('video');
             videoReq.onsuccess = () => {
                 if (videoReq.result) {
                     currentVideoBlob = videoReq.result;
                     currentVideoUrl = URL.createObjectURL(currentVideoBlob);
                     videoPlayer.src = currentVideoUrl;
                     videoContainer.style.display = 'block';
                     document.getElementById('resumeVideoBtn').style.display = 'flex';
                     document.getElementById('toggleVideoVisibilityBtn').style.display = 'flex';
                     
                     const srtReq = store.get('srt');
                     srtReq.onsuccess = () => {
                         if (srtReq.result) {
                             isVideoMode = true;
                             activeBoxId = 'video_mode';
                             parseSRTData(srtReq.result);
                             if(sentences.length > 0) {
                                 resetProgress();
                                 currentSentenceDiv.innerText = "Restored saved Video & SRT! Press Play.";
                                 renderPlaylist();
                                 updateVisibilityStates();
                                 updateScreenOnly();
                             }
                         }
                     };
                 }
             };
         }
         
         // --- RAM Efficiency Engine (Lazy Loading) ---
         function getBoxContent(id) { return localStorage.getItem('app_box_content_' + id) || ''; }
         function setBoxContent(id, text) { localStorage.setItem('app_box_content_' + id, text); }
         function deleteBoxContent(id) { localStorage.removeItem('app_box_content_' + id); }
         function migrateToLazyLoad(node) { if (node.type === 'box' && node.content !== undefined) { setBoxContent(node.id, node.content); delete node.content; } if (node.children) node.children.forEach(migrateToLazyLoad); }
         function buildExportTree(node) { let copy = { ...node }; if (copy.type === 'box') copy.content = getBoxContent(copy.id); if (copy.children) copy.children = copy.children.map(buildExportTree); return copy; }
         function deepDeleteBoxContents(node) { if (node.type === 'box') deleteBoxContent(node.id); if (node.children) node.children.forEach(deepDeleteBoxContents); }
         
         // --- File System State ---
         let fsTree = { id: 'root', type: 'folder', name: 'Home', children: [], isFav: false };
         let currentFolderPath = ['root']; let openBoxId = null; let activeBoxId = null; let playHistory = [];
         function generateId() { return 'id_' + Math.random().toString(36).substr(2, 9); }
         function findNode(node, id) { if (node.id === id) return node; if (node.children) { for (let child of node.children) { let found = findNode(child, id); if (found) return found; } } return null; }
         function findParent(node, id) { if (node.children) { for (let child of node.children) { if (child.id === id) return node; let found = findParent(child, id); if (found) return found; } } return null; }
         function getPathToNode(root, id, path = []) { let currentPath = [...path, root]; if (root.id === id) return currentPath; if (root.children) { for (let c of root.children) { let res = getPathToNode(c, id, currentPath); if (res) return res; } } return null; }
         function getCurrentFolder() { let currentId = currentFolderPath[currentFolderPath.length - 1]; return findNode(fsTree, currentId) || fsTree; }
         
         // --- Sentence Index + Active Tool section hide/show toggle ---
         const sentenceIndexToggleBtn = document.getElementById('sentenceIndexToggleBtn');
         const sentenceIndexControls = document.getElementById('sentenceIndexControls');

         if (sentenceIndexToggleBtn && sentenceIndexControls) {
             sentenceIndexToggleBtn.addEventListener('click', () => {
                 const isHidden = sentenceIndexControls.style.display === 'none';
                 sentenceIndexControls.style.display = isHidden ? '' : 'none';

                 // 🙈 = currently visible, 👁️ = currently hidden
                 sentenceIndexToggleBtn.textContent = isHidden ? '🙈' : '👁️';
                 sentenceIndexToggleBtn.title = isHidden
                     ? 'Hide Sentence Index tools and Active Tool'
                     : 'Show Sentence Index tools and Active Tool';
                 sentenceIndexToggleBtn.setAttribute(
                     'aria-label',
                     isHidden
                         ? 'Hide Sentence Index tools and Active Tool'
                         : 'Show Sentence Index tools and Active Tool'
                 );
                 sentenceIndexToggleBtn.setAttribute('aria-expanded', String(isHidden));
             });
         }

         // --- DOM Elements ---
         const fsContainerView = document.getElementById('fsContainerView'); const boxEditorView = document.getElementById('boxEditorView');
         const breadcrumbsDiv = document.getElementById('breadcrumbs'); const fsSearchInput = document.getElementById('fsSearchInput');
         const fsGrid = document.getElementById('fsGrid'); const currentBoxName = document.getElementById('currentBoxName');
         const boxTextarea = document.getElementById('boxTextarea'); const nowPlayingIndicator = document.getElementById('nowPlayingIndicator');
         
         // Video DOM
         const loadVideoBtn = document.getElementById('loadVideoBtn'); const videoUpload = document.getElementById('videoUpload');
         const videoContainer = document.getElementById('videoContainer'); const videoPlayer = document.getElementById('videoPlayer');

        // --- BACKGROUND AUDIO KEEP-ALIVE ---
        // Android Chrome throttles/suspends speechSynthesis (and can drop the
        // audio focus entirely) once the screen locks or the tab is minimized,
        // because speechSynthesis isn't a real <audio>/<video> element the OS
        // recognizes as "media in progress". A silent looping <audio> element
        // held at real (non-muted, non-zero) volume tricks Chrome into treating
        // this tab as actively playing audio, which keeps it out of the
        // background-throttling / freeze bucket and keeps speech + video audio
        // alive behind the lock screen.
        const silentKeepAlive = document.getElementById('silentKeepAlive');
        silentKeepAlive.src = 'data:audio/wav;base64,UklGRvQHAABXQVZFZm10IBAAAAABAAEAoA8AAKAPAAABAAgAZGF0YdAHAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

        function ensureKeepAlivePlaying() {
            if (!isPlaying) return;
            if (silentKeepAlive.paused) {
                silentKeepAlive.play().catch(() => {});
            }
        }
        function stopKeepAlive() {
            silentKeepAlive.pause();
        }
        // If Android's audio focus rules pause it mid-loop, restart it while we're
        // still supposed to be playing.
        silentKeepAlive.addEventListener('pause', () => {
            if (isPlaying) setTimeout(ensureKeepAlivePlaying, 250);
        });

        // Prevent the screen from dimming/locking on its own while active
        // (this only helps while the app is in the foreground — once the user
        // manually locks the phone, the OS releases the lock, but audio keeps
        // going thanks to the keep-alive track above and Media Session).
        let wakeLockSentinel = null;
        async function requestWakeLock() {
            try {
                if ('wakeLock' in navigator) {
                    wakeLockSentinel = await navigator.wakeLock.request('screen');
                }
            } catch (e) { /* not fatal — background audio still works without it */ }
        }
        function releaseWakeLock() {
            if (wakeLockSentinel) { wakeLockSentinel.release().catch(() => {}); wakeLockSentinel = null; }
        }
                 const loadSrtBtn = document.getElementById('loadSrtBtn'); const srtUpload = document.getElementById('srtUpload');
         const toggleVideoVisibilityBtn = document.getElementById('toggleVideoVisibilityBtn');
         const quickLoadSrtBtn = document.getElementById('quickLoadSrtBtn');
         
         const minWordsInput = document.getElementById('minWordsInput');
         const wordChunkInput = document.getElementById('wordChunkInput');
         const sentenceSearchInput = document.getElementById('sentenceSearchInput');
         const selectAllWrapper = document.getElementById('selectAllWrapper');
         const selectAllCheckbox = document.getElementById('selectAllCheckbox');
         
         const globalDeleteRangeBtn = document.getElementById('globalDeleteRangeBtn');
         const globalTranslateBtn = document.getElementById('globalTranslateBtn'); 
         const stopTranslateBtn = document.getElementById('stopTranslateBtn');
         const globalHideBtn = document.getElementById('globalHideBtn');
         
         const delayInput = document.getElementById('delayInput');
         const lineCountInput = document.getElementById('lineCountInput');
         const sentenceRepeatInput = document.getElementById('sentenceRepeatInput');
         const translationLanguageSelect = document.getElementById('translationLanguageSelect');
         const pauseTimer = document.getElementById('pauseTimer'); const pauseTimerValue = document.getElementById('pauseTimerValue');
         let pauseTimerInterval = null; let pauseDeadline = 0;
         const passageRepeatInput = document.getElementById('passageRepeatInput'); const skipIntervalInput = document.getElementById('skipIntervalInput');
         const speedInput = document.getElementById('speedInput'); const speedValueDisplay = document.getElementById('speedValueDisplay');
         const voiceSelect = document.getElementById('voiceSelect'); const rangeInput = document.getElementById('rangeInput');
         const playStarredOnlyInput = document.getElementById('playStarredOnlyInput'); const shuffleInput = document.getElementById('shuffleInput');
         const themeToggleBtn = document.getElementById('themeToggleBtn'); const openSettingsBtn = document.getElementById('openSettingsBtn');
         const closeSettingsBtn = document.getElementById('closeSettingsBtn'); const settingsModal = document.getElementById('settingsModal');
         const openFavoritesBtn = document.getElementById('openFavoritesBtn'); const closeFavBtn = document.getElementById('closeFavBtn');
         const favModal = document.getElementById('favModal'); const favList = document.getElementById('favList');
         const historyBtn = document.getElementById('historyBtn'); const historyModal = document.getElementById('historyModal');
         const historyList = document.getElementById('historyList'); const closeHistoryBtn = document.getElementById('closeHistoryBtn');
         const globalNotesBtn = document.getElementById('globalNotesBtn'); const globalNotesModal = document.getElementById('globalNotesModal');
         const globalNotesList = document.getElementById('globalNotesList'); const closeGlobalNotesBtn = document.getElementById('closeGlobalNotesBtn');
         const stickyNoteModal = document.getElementById('stickyNoteModal'); const stickyNoteText = document.getElementById('stickyNoteText');
         const saveNoteBtn = document.getElementById('saveNoteBtn'); const cancelNoteBtn = document.getElementById('cancelNoteBtn');
         const closeNoteBtn = document.getElementById('closeNoteBtn');
         const exportBtn = document.getElementById('exportBtn'); const importBtn = document.getElementById('importBtn');
         const importInput = document.getElementById('importInput'); 
         const currentSentenceDiv = document.getElementById('currentSentence');
         const sentenceDisplayCard = document.getElementById('sentenceDisplayCard');
         const pinSentenceBoxBtn = document.getElementById('pinSentenceBoxBtn');
         const playlistSection = document.getElementById('playlistSection'); const playlistContainer = document.getElementById('playlistContainer');
         const floatingTtsBtn = document.getElementById('floatingTtsBtn');
         const progressText = document.getElementById('progressText'); const repeatText = document.getElementById('repeatText');
         const fullscreenToggleBtn = document.getElementById('fullscreenToggleBtn');
         
         const boxStarredBtn = document.getElementById('boxStarredBtn');
         const boxStarredModal = document.getElementById('boxStarredModal');
         const boxStarredList = document.getElementById('boxStarredList');
         const closeBoxStarredBtn = document.getElementById('closeBoxStarredBtn');
         
         const bulkDeleteToggleBtn = document.getElementById('bulkDeleteToggleBtn');
         
         // Parsing Guide Elements
         const parsingGuideModal = document.getElementById('parsingGuideModal');
         const ruleSplitInput = document.getElementById('ruleSplitInput');
         const ruleHideInput = document.getElementById('ruleHideInput');
         
         // --- Playback & Feature State Variables ---
         let sentences = []; let sentenceIndex = 0; let sentenceRepeatCount = 0; let passageRepeatCount = 0; let playedInCurrentLoop = 0; 
         let isPlaying = false; let delayTimeout; let startSentenceIndex = 0; let endSentenceIndex = 0; let starredSentences = new Set();
         let playbackGroupStartIndex = -1;
         let playbackGroupEndIndex = -1;
         let hiddenSentences = new Set(); let customRepeats = {}; let stickyNotes = {}; let translationCache = {}; let translationState = {}; 
         const synth = window.speechSynthesis; let availableVoices = []; let boundarySupported = false; let wordTimers = [];

         // --- Translation Language ---
         function getTranslationLanguage() {
             return (translationLanguageSelect && translationLanguageSelect.value) || localStorage.getItem('app_translation_language') || 'hi';
         }
         function getTranslationCacheKey(sentence, language = getTranslationLanguage()) {
             return `${language}::${sentence}`;
         }
         function getCachedTranslation(sentence, language = getTranslationLanguage()) {
             return translationCache[getTranslationCacheKey(sentence, language)] || '';
         }
         function setCachedTranslation(sentence, translatedText, language = getTranslationLanguage()) {
             translationCache[getTranslationCacheKey(sentence, language)] = translatedText;
         }
         function getTranslationButtonLabel(language = getTranslationLanguage()) {
             const labels = { hi:'अ', as:'অ', bn:'অ', ta:'த', te:'త', mr:'म', gu:'ગ', kn:'ಕ', ml:'മ', pa:'ਪ', ur:'ا', ne:'न', ja:'日', ko:'한', 'zh-CN':'中', 'zh-TW':'繁', fr:'FR', de:'DE', es:'ES', it:'IT', pt:'PT', ru:'РУ', ar:'ع' };
             return labels[language] || '🌐';
         }
         function resetTranslationStatesForNewLanguage() {
             translationState = {};
             localStorage.setItem('app_translation_state', JSON.stringify(translationState));
             if (typeof renderPlaylist === 'function' && sentences && sentences.length) renderPlaylist();
             if (typeof updateActiveSentenceToolbar === 'function') updateActiveSentenceToolbar();
             if (typeof updateScreenOnly === 'function' && !isPlaying && sentences && sentences.length) updateScreenOnly();
         }
         
         let isBulkDeleteMode = false;
         let selectedForDelete = new Set();
         
         // --- Helper Methods ---
         function getWordCount(sentence) {
             if (!sentence) return 0;
             return sentence.split(/\s+/).filter(w => w.trim().length > 0).length;
         }
         
         // --- Full Screen Logic ---
         fullscreenToggleBtn.addEventListener('click', () => {
             if (!document.fullscreenElement) {
                 document.documentElement.requestFullscreen().catch(()=>{});
             } else {
                 document.exitFullscreen();
             }
         });
         document.addEventListener('fullscreenchange', () => {
             if (document.fullscreenElement) {
                 fullscreenToggleBtn.innerText = 'Exit Full Screen';
             } else {
                 fullscreenToggleBtn.innerText = 'Enter Full Screen';
             }
         });
         
         // --- 📌 Pin Sentence Box below the sticky Video ---
         let sentenceBoxPinned = false;

         function updatePinnedSentenceBoxPosition() {
             if (!sentenceDisplayCard) return;

             if (!sentenceBoxPinned) {
                 sentenceDisplayCard.style.removeProperty('--pinned-display-top');
                 return;
             }

             const videoVisible = videoContainer &&
                 getComputedStyle(videoContainer).display !== 'none' &&
                 videoContainer.getBoundingClientRect().height > 0;

             // The video is sticky at top:0. Keep the sentence box immediately below it.
             const videoHeight = videoVisible ? videoContainer.getBoundingClientRect().height : 0;
             const gap = 8;
             sentenceDisplayCard.style.setProperty(
                 '--pinned-display-top',
                 `${Math.max(0, Math.round(videoHeight + gap))}px`
             );
         }

         function setSentenceBoxPinned(pinned) {
             sentenceBoxPinned = !!pinned;

             if (sentenceDisplayCard) {
                 sentenceDisplayCard.classList.toggle('is-pinned', sentenceBoxPinned);
             }

             if (pinSentenceBoxBtn) {
                 pinSentenceBoxBtn.classList.toggle('is-pinned', sentenceBoxPinned);
                 pinSentenceBoxBtn.setAttribute('aria-pressed', String(sentenceBoxPinned));
                 pinSentenceBoxBtn.title = sentenceBoxPinned
                     ? 'Unpin sentence box'
                     : 'Pin sentence box below the video';
                 pinSentenceBoxBtn.setAttribute(
                     'aria-label',
                     sentenceBoxPinned
                         ? 'Unpin sentence box'
                         : 'Pin sentence box below the video'
                 );
             }

             updatePinnedSentenceBoxPosition();
         }

         if (pinSentenceBoxBtn) {
             pinSentenceBoxBtn.addEventListener('click', () => {
                 setSentenceBoxPinned(!sentenceBoxPinned);
             });
         }

         // Keep the pinned box exactly below the video when its size changes.
         window.addEventListener('resize', updatePinnedSentenceBoxPosition);
         if (videoPlayer) {
             videoPlayer.addEventListener('loadedmetadata', updatePinnedSentenceBoxPosition);
             videoPlayer.addEventListener('loadeddata', updatePinnedSentenceBoxPosition);
             videoPlayer.addEventListener('durationchange', updatePinnedSentenceBoxPosition);
         }

         // --- Video & SRT Logic ---
         toggleVideoVisibilityBtn.addEventListener('click', () => {
             if (videoContainer.style.display === 'none') {
                 videoContainer.style.display = 'block';
             } else {
                 videoContainer.style.display = 'none';
             }
             requestAnimationFrame(updatePinnedSentenceBoxPosition);
         });
         
         document.getElementById('resumeVideoBtn').addEventListener('click', () => {
             if (!currentVideoUrl) return;
             isVideoMode = true;
             activeBoxId = 'video_mode';
             videoContainer.style.display = 'block';
             requestAnimationFrame(updatePinnedSentenceBoxPosition);
             if (videoSubtitles.length > 0) {
                 sentences = videoSubtitles.map(s => s.text);
                 resetProgress();
                 renderPlaylist();
                 updateVisibilityStates();
                 updateScreenOnly();
                 currentSentenceDiv.innerText = "Switched to Saved Video Mode!";
             } else {
                 currentSentenceDiv.innerText = "Video active. Please upload an SRT file.";
             }
         });
         
         loadVideoBtn.addEventListener('click', () => videoUpload.click());
         videoUpload.addEventListener('change', (e) => {
             const file = e.target.files[0];
             if (!file) return;
             saveToDB('video', file);
             currentVideoBlob = file;
             if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
             currentVideoUrl = URL.createObjectURL(currentVideoBlob);
             videoPlayer.src = currentVideoUrl;
             videoContainer.style.display = 'block';
             requestAnimationFrame(updatePinnedSentenceBoxPosition);
             document.getElementById('resumeVideoBtn').style.display = 'flex';
             document.getElementById('toggleVideoVisibilityBtn').style.display = 'flex';
             currentSentenceDiv.innerText = "Video saved locally! Now click '📝 SRT' below to upload subtitles.";
             isVideoMode = true;
         });
         
         loadSrtBtn.addEventListener('click', () => srtUpload.click());
         srtUpload.addEventListener('change', (e) => {
             const file = e.target.files[0];
             if (!file) return;
             const reader = new FileReader();
             reader.onload = (evt) => {
                 const text = evt.target.result;
                 saveToDB('srt', text);
                 activeSrtView = 'primary';
                 localStorage.setItem('app_srt_view', 'primary');
                 isVideoMode = true;
                 activeBoxId = 'video_mode';
                 
                 parseSRTData(text);
                 
                 if(sentences.length > 0) {
                     resetProgress();
                     currentSentenceDiv.innerText = "SRT Synced! Press Play to start video speaking practice.";
                     renderPlaylist();
                     updateVisibilityStates();
                     
                     if (!isPlayable(sentenceIndex)) {
                         let nextValid = getFirstPlayableIndex();
                         if(nextValid !== -1) sentenceIndex = nextValid;
                     }
                     updateScreenOnly();
                 } else {
                     currentSentenceDiv.innerText = "Failed to parse SRT file. Please ensure it is a valid format.";
                 }
             };
             reader.readAsText(file);
             e.target.value = '';
         });

         loadSecondSrtBtn.addEventListener('click', () => secondSrtUpload.click());
         secondSrtUpload.addEventListener('change', (e) => {
             const file = e.target.files[0];
             if (!file) return;
             const reader = new FileReader();
             reader.onload = (evt) => {
                 const text = evt.target.result;
                 const parsed = parseSRTSubtitles(text);
                 if (!parsed.length) {
                     alert('Failed to parse second SRT file. Please ensure it is a valid SRT format.');
                     return;
                 }
                 secondSrtSubtitles = parsed;
                 saveToDB('srt2', text);
                 // Keep the first/fast SRT visible after upload. The user
                 // explicitly switches to the second SRT with the 🔄 button.
                 activeSrtView = 'primary';
                 localStorage.setItem('app_srt_view', activeSrtView);
                 updateSecondSrtButtonStates();
                 renderPlaylist();
                 updateVisibilityStates();
                 updateScreenOnly();
             };
             reader.readAsText(file);
             e.target.value = '';
         });

         toggleSrtViewBtn.addEventListener('click', () => {
             if (!secondSrtSubtitles.length) {
                 alert("Please upload a second SRT first.");
                 return;
             }
             activeSrtView = activeSrtView === 'primary' ? 'secondary' : 'primary';
             localStorage.setItem('app_srt_view', activeSrtView);
             updateSecondSrtButtonStates();
             renderPlaylist();
             updateVisibilityStates();
             highlightActivePlaylistSentence();
         });

         showSecondSrtBtn.addEventListener('click', () => {
             if (!secondSrtSubtitles.length) {
                 alert("Please upload a second SRT first.");
                 return;
             }
             showSecondSrtCurrentLine = !showSecondSrtCurrentLine;
             localStorage.setItem('app_show_second_srt', String(showSecondSrtCurrentLine));
             updateSecondSrtButtonStates();
             updateScreenOnly();
         });

         // Quick SRT Load logic
         quickLoadSrtBtn.addEventListener('click', () => {
             if (!db) return;
             const tx = db.transaction('mediaStore', 'readonly');
             const store = tx.objectStore('mediaStore');
             const srtReq = store.get('srt');
             srtReq.onsuccess = () => {
                 if (srtReq.result) {
                     isVideoMode = true;
                     activeBoxId = 'video_mode';
                     activeSrtView = 'primary';
                     localStorage.setItem('app_srt_view', 'primary');
                     parseSRTData(srtReq.result);
                     if(sentences.length > 0) {
                         resetProgress();
                         currentSentenceDiv.innerText = "Saved SRT Loaded!";
                         renderPlaylist();
                         updateVisibilityStates();
                         if (!isPlayable(sentenceIndex)) {
                             let nextValid = getFirstPlayableIndex();
                             if(nextValid !== -1) sentenceIndex = nextValid;
                         }
                         updateScreenOnly();
                     }
                 } else {
                     alert("No saved SRT found. Please upload one using the '📝 SRT' button first.");
                 }
             };
         });
         
         function parseSRTSubtitles(data) {
             const normalizedData = String(data || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
             const blocks = normalizedData.split(/\n{2,}/);
             const subtitles = [];

             blocks.forEach(block => {
                 const lines = block.trim().split('\n');
                 if (lines.length < 2) return;

                 // Find the timestamp line instead of assuming it is always line 2.
                 const timeIndex = lines.findIndex(line => /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(line));
                 if (timeIndex === -1) return;

                 const timeMatch = lines[timeIndex].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
                 if (!timeMatch) return;

                 const start = timeToSeconds(timeMatch[1]);
                 const end = timeToSeconds(timeMatch[2]);
                 if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;

                 const text = lines.slice(timeIndex + 1)
                     .join(' ')
                     .replace(/<[^>]+>/g, '')
                     .replace(/\s+/g, ' ')
                     .trim();

                 if (text) subtitles.push({ start, end, text });
             });

             return subtitles;
         }

         function parseSRTData(data) {
             videoSubtitles = parseSRTSubtitles(data);
             sentences = videoSubtitles.map(s => s.text);
         }

         function timeToSeconds(t) {
             let p = t.split(':');
             let s = p[2].split(/[,.]/); 
             return parseInt(p[0], 10)*3600 + parseInt(p[1], 10)*60 + parseInt(s[0], 10) + parseInt(s[1], 10)/1000;
         }
         
         function getActiveSrtList() {
             return activeSrtView === 'secondary' ? secondSrtSubtitles : videoSubtitles;
         }

         function findPrimaryIndexForSecondCue(secondIndex) {
             if (!secondSrtSubtitles[secondIndex] || !videoSubtitles.length) return -1;
             const cue = secondSrtSubtitles[secondIndex];
             const center = (cue.start + cue.end) / 2;

             // Prefer a primary cue that overlaps the second cue.
             let bestOverlap = -1;
             let bestOverlapAmount = -1;
             videoSubtitles.forEach((primary, index) => {
                 const overlap = Math.max(0, Math.min(cue.end, primary.end) - Math.max(cue.start, primary.start));
                 if (overlap > bestOverlapAmount) {
                     bestOverlapAmount = overlap;
                     bestOverlap = index;
                 }
             });
             if (bestOverlapAmount > 0) return bestOverlap;

             // If there is no overlap, use the closest cue center.
             let bestIndex = 0;
             let bestDistance = Infinity;
             videoSubtitles.forEach((primary, index) => {
                 const primaryCenter = (primary.start + primary.end) / 2;
                 const distance = Math.abs(primaryCenter - center);
                 if (distance < bestDistance) {
                     bestDistance = distance;
                     bestIndex = index;
                 }
             });
             return bestIndex;
         }

         function findSecondSrtAtTime(time) {
             if (!secondSrtSubtitles.length || !Number.isFinite(time)) return null;
             for (let i = 0; i < secondSrtSubtitles.length; i++) {
                 const cue = secondSrtSubtitles[i];
                 if (time >= cue.start && time < cue.end) return { cue, index: i };
             }
             return null;
         }

         function updateSecondSrtButtonStates() {
             const hasSecond = secondSrtSubtitles.length > 0;
             if (loadSecondSrtBtn) {
                 loadSecondSrtBtn.title = hasSecond ? 'Replace second SRT' : 'Upload second SRT';
                 loadSecondSrtBtn.classList.toggle('has-second-srt', hasSecond);
             }
             if (toggleSrtViewBtn) {
                 toggleSrtViewBtn.disabled = !hasSecond;
                 toggleSrtViewBtn.style.opacity = hasSecond ? '1' : '0.5';
                 toggleSrtViewBtn.innerText = activeSrtView === 'secondary' ? '1️⃣' : '🔄';
                 toggleSrtViewBtn.title = hasSecond
                     ? (activeSrtView === 'secondary' ? 'Show first SRT in Sentence Index' : 'Show second SRT in Sentence Index')
                     : 'Upload a second SRT first';
                 toggleSrtViewBtn.setAttribute('aria-pressed', String(activeSrtView === 'secondary'));
             }
             if (showSecondSrtBtn) {
                 showSecondSrtBtn.disabled = !hasSecond;
                 showSecondSrtBtn.style.opacity = hasSecond ? '1' : '0.5';
                 showSecondSrtBtn.classList.toggle('is-active', showSecondSrtCurrentLine && hasSecond);
                 showSecondSrtBtn.setAttribute('aria-pressed', String(showSecondSrtCurrentLine && hasSecond));
                 showSecondSrtBtn.title = hasSecond
                     ? (showSecondSrtCurrentLine ? 'Hide second SRT current line' : 'Show second SRT current line below first SRT')
                     : 'Upload a second SRT first';
             }
         }

         function renderSecondSrtCurrentLine() {
             if (!showSecondSrtCurrentLine || !secondSrtSubtitles.length || !isVideoMode || !videoPlayer) return '';
             const found = findSecondSrtAtTime(videoPlayer.currentTime);
             if (!found) return '';
             return `<div class="second-srt-current-line" data-second-srt-index="${found.index}"><span class="second-srt-label">2️⃣</span> ${renderSentenceWithWords(found.cue.text)}</div>`;
         }

         function updateSecondSrtCurrentLine() {
             const host = currentSentenceDiv ? currentSentenceDiv.querySelector('.second-srt-current-line') : null;
             if (!host) return;
             const found = findSecondSrtAtTime(videoPlayer ? videoPlayer.currentTime : NaN);
             if (!found) {
                 host.style.display = 'none';
                 host.removeAttribute('data-second-srt-index');
                 return;
             }
             host.style.display = 'block';
             host.dataset.secondSrtIndex = String(found.index);
             host.innerHTML = `<span class="second-srt-label">2️⃣</span> ${renderSentenceWithWords(found.cue.text)}`;
         }

         // --- State Auto-Saving & Persistence ---
         function saveFS() { localStorage.setItem('app_fs_tree', JSON.stringify(fsTree)); localStorage.setItem('app_active_box_id', activeBoxId || ''); }
         function loadFS() { let savedFS = localStorage.getItem('app_fs_tree'); if (savedFS) { try { fsTree = JSON.parse(savedFS); migrateToLazyLoad(fsTree); } catch(e) { fsTree = { id: 'root', type: 'folder', name: 'Home', children: [], isFav: false }; } } else { fsTree = { id: 'root', type: 'folder', name: 'Home', children: [], isFav: false }; } activeBoxId = localStorage.getItem('app_active_box_id') || null; }
         
         function cleanSrtText() {
             if (!openBoxId) return;
             let text = boxTextarea.value;
             if (!text.trim()) { alert("Please paste SRT text first."); return; }
             let lines = text.split(/\r?\n/);
             let cleanedLines = [];
             for (let i = 0; i < lines.length; i++) {
                 let line = lines[i].trim();
                 if (!line) continue;
                 if (/^\d+$/.test(line)) continue;
                 if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(line)) continue;
                 line = line.replace(/<[^>]+>/g, '');
                 line = line.replace(/\([^)]+\)/g, '').replace(/\[[^\]]+\]/g, '');
                 line = line.replace(/^-\s*/, '');
                 line = line.trim();
                 if (line) cleanedLines.push(line);
             }
             let newText = cleanedLines.join(' ').replace(/\s{2,}/g, ' ');
             boxTextarea.value = newText;
             setBoxContent(openBoxId, newText);
             if (openBoxId === activeBoxId) { 
                 sentences = []; 
                 if (newText.trim()) parseSentencesIfNeeded(); 
                 resetProgress(); 
                 updateScreenOnly(); 
             }
             const btn = document.getElementById('srtCleanBtn');
             const orig = btn.innerHTML; btn.innerHTML = "✅"; setTimeout(() => btn.innerHTML = orig, 1500);
         }
         
         function cleanPdfText() {
             if (!openBoxId) return;
             let text = boxTextarea.value;
             if (!text.trim()) { alert("Please paste PDF vocabulary text first."); return; }
             let lines = text.split(/\r?\n/);
             let cleanedSentences = []; let currentWord = "";
             for (let i = 0; i < lines.length; i++) {
                 let line = lines[i].trim();
                 line = line.replace(/^[•*\-\u2022]\s*/, '').trim();
                 if (!line) continue;
                 let wordMatch = line.match(/^\d+\.\s*(?:Word:\s*)?([A-Za-z\-]+(?:\s+[A-Za-z\-]+)*)/i);
                 if (wordMatch) { currentWord = wordMatch[1].trim(); continue; }
                 let exMatch = line.match(/Example(?: Sentence)?:\s*(.+)/i);
                 if (exMatch && currentWord) {
                     let exampleText = exMatch[1].trim();
                     exampleText = exampleText.replace(/\s*\([^)]+\)$/, '').trim();
                     cleanedSentences.push(`${currentWord} , ${exampleText}`);
                     currentWord = ""; 
                 }
             }
             let newText = cleanedSentences.join('\n\n');
             if(!newText.trim()){ alert("Could not detect standard 'Word' and 'Example Sentence' pattern."); return; }
             boxTextarea.value = newText; setBoxContent(openBoxId, newText);
             if (openBoxId === activeBoxId) { 
                 sentences = []; 
                 if (newText.trim()) parseSentencesIfNeeded(); 
                 resetProgress(); 
                 updateScreenOnly(); 
             }
             const btn = document.getElementById('pdfCleanBtn');
             const orig = btn.innerHTML; btn.innerHTML = "✅"; setTimeout(() => btn.innerHTML = orig, 1500);
         }
         
         function customCleanText() {
             if (!openBoxId) return;
             let text = boxTextarea.value;
             if (!text.trim()) { alert("Box is empty."); return; }
             let toRemove = prompt("Enter the character, symbol, or word to remove permanently:");
             if (toRemove !== null && toRemove !== "") {
                 let newText = text.split(toRemove).join('');
                 boxTextarea.value = newText; setBoxContent(openBoxId, newText);
                 if (openBoxId === activeBoxId) { 
                     sentences = []; 
                     if (newText.trim()) parseSentencesIfNeeded(); 
                     resetProgress(); 
                     updateScreenOnly(); 
                 }
                 const btn = document.getElementById('cstmCleanBtn');
                 const orig = btn.innerHTML; btn.innerHTML = "✅"; setTimeout(() => btn.innerHTML = orig, 1500);
             }
         }
         
         // --- Bulk Delete Logic ---
         bulkDeleteToggleBtn.addEventListener('click', () => {
             if (!sentences || sentences.length === 0) return;
             if (!isBulkDeleteMode) {
                 isBulkDeleteMode = true;
                 selectedForDelete.clear();
                 bulkDeleteToggleBtn.style.backgroundColor = '#ef4444';
                 bulkDeleteToggleBtn.style.color = 'white';
                 bulkDeleteToggleBtn.innerHTML = '🗑️(0)';
                 selectAllWrapper.style.display = 'flex';
                 selectAllCheckbox.checked = false;
                 renderPlaylist();
             } else {
                 if (selectedForDelete.size > 0) {
                     if (confirm(`Are you sure you want to delete ${selectedForDelete.size} sentences permanently?`)) {
                         let sortedIndices = Array.from(selectedForDelete).sort((a,b) => b-a);
                         sortedIndices.forEach(idx => {
                             sentences.splice(idx, 1);
                             if (isVideoMode) videoSubtitles.splice(idx, 1);
                         });
                         
                         if (!isVideoMode) {
                             let newText = sentences.join(' ');
                             let box = findNode(fsTree, activeBoxId);
                             if (box) {
                                 setBoxContent(activeBoxId, newText);
                                 if (openBoxId === activeBoxId && boxTextarea) boxTextarea.value = newText;
                             }
                         }
                         if (sentenceIndex >= sentences.length) sentenceIndex = Math.max(0, sentences.length - 1);
                         saveProgress();
                         
                         if(sentences.length > 0) {
                             updateVisibilityStates();
                             if (!isPlayable(sentenceIndex)) {
                                 let nextValid = getFirstPlayableIndex();
                                 if(nextValid !== -1) sentenceIndex = nextValid;
                             }
                             updateScreenOnly();
                         } else {
                             resetProgress();
                             currentSentenceDiv.innerText = "Box is now empty.";
                         }
                     }
                 }
                 isBulkDeleteMode = false;
                 selectedForDelete.clear();
                 bulkDeleteToggleBtn.style.backgroundColor = '';
                 bulkDeleteToggleBtn.style.color = '';
                 bulkDeleteToggleBtn.innerHTML = '🗑️☑️';
                 selectAllWrapper.style.display = 'none';
                 renderPlaylist();
             }
         });
         
         selectAllCheckbox.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            if (isChecked) {
                sentences.forEach((sentence, index) => {
                    const el = document.getElementById(`playlist-item-${index}`);
                    if (el && !el.classList.contains('filtered-out')) {
                        selectedForDelete.add(index);
                    }
                });
            } else {
                selectedForDelete.clear();
            }
            bulkDeleteToggleBtn.innerHTML = `🗑️(${selectedForDelete.size})`;
            if (selectedForDelete.size > 0) bulkDeleteToggleBtn.style.backgroundColor = '#ef4444';
            else bulkDeleteToggleBtn.style.backgroundColor = '#ef4444'; 
            document.querySelectorAll('.sentence-wrapper').forEach((wrapper, index) => {
                if (!wrapper.classList.contains('filtered-out')) {
                    const cb = wrapper.querySelector('.sentence-top-row input[type="checkbox"]');
                    if (cb) cb.checked = isChecked;
                }
            });
         });
         
         // Modals Setup
         historyBtn.addEventListener('click', () => { historyList.innerHTML = ''; if (playHistory.length === 0) { historyList.innerHTML = '<p style="color:var(--label-color); text-align:center;">No recent history.</p>'; } else { playHistory.forEach(id => { let node = findNode(fsTree, id); if (node) { let pathNodes = getPathToNode(fsTree, id); let pathStr = pathNodes ? pathNodes.map(n => n.name).join(' / ') : node.name; let el = document.createElement('div'); el.className = 'fav-item'; el.innerHTML = `<div><div class="fav-item-title">📄 ${node.name}</div><div class="fav-item-path">${pathStr}</div></div>`; el.onclick = () => { playBoxDirectly(id); historyModal.classList.remove('active'); }; historyList.appendChild(el); } }); } historyModal.classList.add('active'); }); closeHistoryBtn.addEventListener('click', () => historyModal.classList.remove('active')); historyModal.addEventListener('click', (e) => { if (e.target === historyModal) historyModal.classList.remove('active'); });
         function toggleFav(id) { let node = findNode(fsTree, id); if(node) { node.isFav = !node.isFav; saveFS(); renderFS(); } } openFavoritesBtn.addEventListener('click', () => { favList.innerHTML = ''; let favs = []; function traverse(node, pathArray) { if (node.id !== 'root' && node.isFav) favs.push({ node, path: pathArray }); if (node.children) node.children.forEach(c => traverse(c, [...pathArray, node.name])); } traverse(fsTree, []); if (favs.length === 0) favList.innerHTML = '<p style="color:var(--label-color); text-align:center;">No favorites saved yet.</p>'; else { favs.forEach(f => { let el = document.createElement('div'); el.className = 'fav-item'; el.innerHTML = `<div><div class="fav-item-title">${f.node.type === 'folder' ? '📁' : '📄'} ${f.node.name}</div><div class="fav-item-path">${f.path.join(' / ')}</div></div><div class="fav-heart-btn" style="color:var(--danger); font-size:1.5rem; cursor:pointer;" title="Remove">❤️</div>`; el.onclick = (e) => { if(e.target.classList.contains('fav-heart-btn')){ e.stopPropagation(); toggleFav(f.node.id); openFavoritesBtn.click(); return; } navigateToNode(f.node.id); favModal.classList.remove('active'); }; favList.appendChild(el); }); } favModal.classList.add('active'); }); closeFavBtn.addEventListener('click', () => favModal.classList.remove('active')); favModal.addEventListener('click', (e) => { if (e.target === favModal) favModal.classList.remove('active'); });
         // --- All Notes: open notes with an individual ❌ delete button ---
         function deleteSentenceFromAllNotes(index) {
             if (index < 0 || index >= sentences.length) return;

             const sentence = sentences[index];
             const wasPlaying = isPlaying;
             if (wasPlaying) togglePlayPause();

             sentences.splice(index, 1);
             if (isVideoMode) {
                 videoSubtitles.splice(index, 1);
             } else {
                 const newText = sentences.join(' ');
                 const box = findNode(fsTree, activeBoxId);
                 if (box) {
                     setBoxContent(activeBoxId, newText);
                     if (openBoxId === activeBoxId && boxTextarea) boxTextarea.value = newText;
                 }
             }

             // Remove the associated note too.
             delete stickyNotes[sentence];
             localStorage.setItem('app_sticky_notes', JSON.stringify(stickyNotes));

             if (sentenceIndex > index) sentenceIndex--;
             if (sentenceIndex >= sentences.length) {
                 sentenceIndex = Math.max(0, sentences.length - 1);
             }

             saveProgress();

             if (sentences.length > 0) {
                 updateVisibilityStates();
                 if (!isPlayable(sentenceIndex)) {
                     const nextIdx = getFirstPlayableIndex();
                     if (nextIdx !== -1) sentenceIndex = nextIdx;
                 }
                 updateScreenOnly();
                 renderPlaylist();
                 if (wasPlaying && isPlayable(sentenceIndex)) {
                     isPlaying = true;
                     speakNext();
                     updateFloatingBtn();
                 }
             } else {
                 resetProgress();
                 currentSentenceDiv.innerText = 'Box is now empty.';
                 renderPlaylist();
             }
         }

         function renderAllNotes() {
             globalNotesList.innerHTML = '';
             const currentBoxNotes = [];

             if (sentences && sentences.length > 0) {
                 sentences.forEach((sentence, index) => {
                     if (stickyNotes[sentence]) currentBoxNotes.push([sentence, stickyNotes[sentence], index]);
                 });
             }

             if (currentBoxNotes.length === 0) {
                 globalNotesList.innerHTML = '<p style="color:var(--label-color); text-align:center;">No sticky notes found for this box.</p>';
             } else {
                 currentBoxNotes.forEach(([sentence, note, index]) => {
                     const el = document.createElement('div');
                     el.className = 'fav-item all-notes-item';
                     el.style.flexDirection = 'column';
                     el.style.alignItems = 'stretch';
                     el.style.cursor = 'pointer';
                     el.style.position = 'relative';
                     el.style.paddingRight = '3.5rem';

                     const textDiv = document.createElement('div');
                     textDiv.style.fontWeight = '600';
                     textDiv.style.fontSize = '0.9rem';
                     textDiv.style.marginBottom = '0.5rem';
                     textDiv.style.color = 'var(--label-color)';
                     textDiv.style.borderBottom = '1px solid var(--border-color)';
                     textDiv.style.paddingBottom = '0.3rem';
                     textDiv.style.width = '100%';
                     textDiv.textContent = `"${sentence}"`;

                     const noteDiv = document.createElement('div');
                     noteDiv.style.fontSize = '1rem';
                     noteDiv.style.color = 'var(--text-color)';
                     noteDiv.style.whiteSpace = 'pre-wrap';
                     noteDiv.textContent = note;

                     const deleteBtn = document.createElement('button');
                     deleteBtn.type = 'button';
                     deleteBtn.className = 'all-notes-delete-btn';
                     deleteBtn.innerHTML = '❌';
                     deleteBtn.title = 'Remove this sentence from the box';
                     deleteBtn.setAttribute('aria-label', 'Remove this sentence from the box');
                     deleteBtn.addEventListener('click', (e) => {
                         e.preventDefault();
                         e.stopPropagation();
                         deleteSentenceFromAllNotes(index);
                         renderAllNotes();
                     });

                     el.appendChild(textDiv);
                     el.appendChild(noteDiv);
                     el.appendChild(deleteBtn);

                     el.addEventListener('click', () => {
                         const idx = sentences.indexOf(sentence);
                         if (idx !== -1) {
                             globalNotesModal.classList.remove('active');
                             jumpToSpecificSentence(idx);
                         }
                     });

                     globalNotesList.appendChild(el);
                 });
             }
         }

         globalNotesBtn.addEventListener('click', () => {
             renderAllNotes();
             globalNotesModal.classList.add('active');
         });
         closeGlobalNotesBtn.addEventListener('click', () => globalNotesModal.classList.remove('active'));
         globalNotesModal.addEventListener('click', (e) => { if (e.target === globalNotesModal) globalNotesModal.classList.remove('active'); });
         
         boxStarredBtn.addEventListener('click', () => { 
             boxStarredList.innerHTML = ''; 
             let hasStarred = false; 
             if (sentences && sentences.length > 0) { 
                 sentences.forEach((sentence, index) => { 
                     if (starredSentences.has(sentence)) { 
                         hasStarred = true; 
                         let el = document.createElement('div'); 
                         el.className = 'fav-item'; 
                         el.style.flexDirection = 'row'; 
                         el.style.alignItems = 'center'; 
                         el.style.justifyContent = 'space-between';
                         
                         let textDiv = document.createElement('div');
                         textDiv.style.fontWeight = '600';
                         textDiv.style.fontSize = '0.95rem';
                         textDiv.style.color = 'var(--text-color)';
                         textDiv.style.lineHeight = '1.5';
                         textDiv.style.flexGrow = '1';
                         textDiv.style.cursor = 'pointer';
                         textDiv.innerHTML = `${index + 1}. ${sentence}`;
                         textDiv.onclick = () => { 
                             boxStarredModal.classList.remove('active'); 
                             jumpToSpecificSentence(index); 
                         }; 

                         let starBtn = document.createElement('div');
                         starBtn.innerHTML = '⭐';
                         starBtn.style.fontSize = '1.2rem';
                         starBtn.style.cursor = 'pointer';
                         starBtn.style.marginLeft = '10px';
                         starBtn.style.flexShrink = '0';
                         starBtn.style.transition = 'transform 0.2s';
                         starBtn.title = 'Remove from Starred';
                         
                         starBtn.onmouseover = () => starBtn.style.transform = 'scale(1.2)';
                         starBtn.onmouseout = () => starBtn.style.transform = 'scale(1)';

                         starBtn.onclick = (e) => {
                             e.stopPropagation();
                             starredSentences.delete(sentence);
                             localStorage.setItem('app_starred', JSON.stringify(Array.from(starredSentences)));
                             updateVisibilityStates();
                             updateActiveSentenceToolbar();
                             el.remove();
                             if (boxStarredList.children.length === 0) {
                                 boxStarredList.innerHTML = '<p style="color:var(--label-color); text-align:center;">No starred sentences in this box.</p>';
                             }
                         };

                         el.appendChild(textDiv);
                         el.appendChild(starBtn);
                         boxStarredList.appendChild(el); 
                     } 
                 }); 
             } 
             if (!hasStarred) { 
                 boxStarredList.innerHTML = '<p style="color:var(--label-color); text-align:center;">No starred sentences in this box.</p>'; 
             } 
             boxStarredModal.classList.add('active'); 
         }); 
         closeBoxStarredBtn.addEventListener('click', () => boxStarredModal.classList.remove('active')); boxStarredModal.addEventListener('click', (e) => { if (e.target === boxStarredModal) boxStarredModal.classList.remove('active'); });
         
         function openParsingGuide() { ruleSplitInput.value = ruleHardSplit; ruleHideInput.value = ruleHideBlock; parsingGuideModal.classList.add('active'); }
         document.getElementById('closeGuideBtn').addEventListener('click', () => parsingGuideModal.classList.remove('active'));
         document.getElementById('saveRulesBtn').addEventListener('click', () => { ruleHardSplit = ruleSplitInput.value; ruleHideBlock = ruleHideInput.value; localStorage.setItem('app_rule_split', ruleHardSplit); localStorage.setItem('app_rule_hide', ruleHideBlock); parsingGuideModal.classList.remove('active'); if (openBoxId === activeBoxId && !isVideoMode) { if(parseSentencesIfNeeded()) resetProgress(); updateScreenOnly(); } });
         parsingGuideModal.addEventListener('click', (e) => { if (e.target === parsingGuideModal) parsingGuideModal.classList.remove('active'); });
         
         // File System
         function navigateToNode(id) { let pathNodes = getPathToNode(fsTree, id); if (!pathNodes) return; let targetNode = pathNodes[pathNodes.length - 1]; fsSearchInput.value = ''; if (targetNode.type === 'folder') { currentFolderPath = pathNodes.map(n => n.id); renderFS(); } else { currentFolderPath = pathNodes.slice(0, -1).map(n => n.id); renderFS(); openBoxEditor(targetNode.id); } }
         fsSearchInput.addEventListener('input', () => { renderFS(); }); function renderBreadcrumbs() { breadcrumbsDiv.innerHTML = '🏠 '; let pathNodes = currentFolderPath.map(id => findNode(fsTree, id)).filter(n => n); pathNodes.forEach((node, index) => { let span = document.createElement('span'); span.innerText = node.name; if (index < pathNodes.length - 1) { span.className = 'crumb-link'; span.onclick = () => { currentFolderPath = currentFolderPath.slice(0, index + 1); fsSearchInput.value = ''; renderFS(); }; breadcrumbsDiv.appendChild(span); let sep = document.createElement('span'); sep.innerText = ' / '; sep.style.margin = '0 0.4rem'; sep.style.color = 'var(--label-color)'; breadcrumbsDiv.appendChild(sep); } else breadcrumbsDiv.appendChild(span); }); }
         function renderFS() { fsContainerView.style.display = 'block'; boxEditorView.style.display = 'none'; renderBreadcrumbs(); let searchQuery = fsSearchInput.value.trim().toLowerCase(); let itemsToRender = []; if (searchQuery) { function searchNodes(node) { if (node.id !== 'root' && node.name.toLowerCase().includes(searchQuery)) itemsToRender.push(node); if (node.children) node.children.forEach(searchNodes); } searchNodes(fsTree); } else { let currentFolder = getCurrentFolder(); if (!currentFolder) { currentFolderPath = ['root']; currentFolder = getCurrentFolder(); } itemsToRender = [...currentFolder.children]; } fsGrid.innerHTML = ''; if (itemsToRender.length === 0) { fsGrid.innerHTML = `<div style="width: 100%; text-align: center; color: var(--label-color); padding: 2rem;">${searchQuery ? 'No results found.' : 'This folder is empty.'}</div>`; return; } let sortedChildren = itemsToRender.sort((a, b) => { if (a.type === b.type) return a.name.localeCompare(b.name); return a.type === 'folder' ? -1 : 1; }); sortedChildren.forEach(item => { let el = document.createElement('div'); el.className = `fs-item ${item.id === activeBoxId ? 'is-active-box' : ''}`; let pathStr = ''; if (searchQuery) { let pathObj = getPathToNode(fsTree, item.id); if(pathObj) pathStr = pathObj.map(n => n.name).join(' / '); } el.title = searchQuery ? pathStr : item.name; let icon = item.type === 'folder' ? '📁' : '📄'; el.innerHTML = `<div class="fs-item-header"><div class="fs-item-fav ${item.isFav ? 'active' : ''}" title="Favorite" onclick="event.stopPropagation(); toggleFav('${item.id}')">${item.isFav ? '❤️' : '🤍'}</div><div class="fs-item-icon">${icon}</div><div class="fs-item-name">${item.name}</div></div>${searchQuery ? `<div style="font-size:0.7rem; color:var(--label-color); margin-top:0.3rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${pathStr}</div>` : ''}<div class="fs-item-ctrls" onclick="event.stopPropagation()">${item.type === 'box' ? `<button class="fs-ctrl-btn play-btn" title="Play directly" onclick="playBoxDirectly('${item.id}')">▶️</button>` : ''}<button class="fs-ctrl-btn" title="Rename" onclick="renameNode('${item.id}')">✏️</button><button class="fs-ctrl-btn del-btn" title="Delete" onclick="deleteNode('${item.id}')">🗑️</button></div>`; el.onclick = () => { navigateToNode(item.id); }; fsGrid.appendChild(el); }); }
         function createFolder() { let name = prompt("Enter new folder name:"); if (!name || !name.trim()) return; getCurrentFolder().children.push({ id: generateId(), type: 'folder', name: name.trim(), children: [], isFav: false }); saveFS(); renderFS(); scrollToEndOfGrid(); }
         function createBox() { let name = prompt("Enter new box name (e.g. Chapter 1):"); if (!name || !name.trim()) return; getCurrentFolder().children.push({ id: generateId(), type: 'box', name: name.trim(), isFav: false }); saveFS(); renderFS(); scrollToEndOfGrid(); }
         function scrollToEndOfGrid() { setTimeout(() => { fsGrid.scrollLeft = fsGrid.scrollWidth; }, 50); }
         function renameNode(id) { let node = findNode(fsTree, id); if (!node) return; let newName = prompt(`Rename ${node.type}:`, node.name); if (newName && newName.trim()) { node.name = newName.trim(); saveFS(); renderFS(); if(id === openBoxId) currentBoxName.innerHTML = `📄 ${node.name}`; } }
         function deleteNode(id) { if (!confirm("Are you sure you want to delete this permanently?")) return; let parent = findParent(fsTree, id); if (parent) { let nodeToDelete = findNode(fsTree, id); if (nodeToDelete) deepDeleteBoxContents(nodeToDelete); if (nodeToDelete && nodeToDelete.type === 'folder') { if (activeBoxId && getPathToNode(nodeToDelete, activeBoxId)) { activeBoxId = null; resetProgress(); currentSentenceDiv.innerText = "Active box deleted."; updateNowPlaying(); } if (openBoxId && getPathToNode(nodeToDelete, openBoxId)) { closeBoxEditor(); } } else { if (id === activeBoxId) { activeBoxId = null; resetProgress(); currentSentenceDiv.innerText = "Active box deleted."; updateNowPlaying(); } if (id === openBoxId) { closeBoxEditor(); } } parent.children = parent.children.filter(c => c.id !== id); playHistory = playHistory.filter(histId => histId !== id); localStorage.setItem('app_play_history', JSON.stringify(playHistory)); saveFS(); renderFS(); } }
         function openBoxEditor(id) { let box = findNode(fsTree, id); if (!box || box.type !== 'box') return; openBoxId = id; fsContainerView.style.display = 'none'; boxEditorView.style.display = 'block'; currentBoxName.innerHTML = `📄 ${box.name}`; boxTextarea.value = getBoxContent(id); }
         
         // UNLOCK TEXTAREA WHEN CLOSING BOX EDITOR
         function closeBoxEditor() { openBoxId = null; boxTextarea.value = ''; boxTextarea.readOnly = false; renderFS(); } 
         
         boxTextarea.addEventListener('input', (e) => { 
             if (!openBoxId) return; 
             let box = findNode(fsTree, openBoxId); 
             if (box) { 
                 setBoxContent(openBoxId, e.target.value); 
                 if (openBoxId === activeBoxId && !isVideoMode) { 
                     sentences = []; // Force re-parse
                     if(e.target.value.trim()) parseSentencesIfNeeded(); 
                     resetProgress(); 
                 } 
             } 
         });
         function updateNowPlaying() { if (!activeBoxId || isVideoMode) { nowPlayingIndicator.style.display = 'none'; return; } let path = getPathToNode(fsTree, activeBoxId); if (path) { nowPlayingIndicator.style.display = 'flex'; nowPlayingIndicator.innerHTML = `🎧 ${path.map(n => n.name).join(' / ')}`; } }
         nowPlayingIndicator.addEventListener('click', () => { if (activeBoxId && !isVideoMode) { let pathNodes = getPathToNode(fsTree, activeBoxId); if (!pathNodes) return; currentFolderPath = pathNodes.slice(0, -1).map(n => n.id); closeBoxEditor(); renderFS(); setTimeout(() => { let activeEl = document.querySelector('.fs-item.is-active-box'); if(activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 100); } });
         
         function playBoxInternal(boxId) { 
             isVideoMode = false;
             document.getElementById('videoContainer').style.display = 'none';
             
             // Very important: Clear out the old sentences memory to force a reload when clicking play
             sentences = []; 
             activeBoxId = boxId; 
             
             saveFS(); updateNowPlaying(); 
             playHistory = playHistory.filter(id => id !== boxId); playHistory.unshift(boxId); if (playHistory.length > 5) playHistory.pop(); localStorage.setItem('app_play_history', JSON.stringify(playHistory)); 
             let box = findNode(fsTree, activeBoxId); let content = getBoxContent(activeBoxId); 
             if (box && content && content.trim()) { 
                 if (parseSentencesIfNeeded()) { 
                     resetProgress();
                     updateVisibilityStates(); 
                     if (!isPlayable(sentenceIndex)) { 
                         let nextValid = getFirstPlayableIndex(); 
                         if (nextValid !== -1) sentenceIndex = nextValid; 
                     } 
                     updateScreenOnly(); 
                     
                     // AUTO PLAY IMMEDIATELY
                     if (!isPlaying) {
                         isPlaying = true;
                         speakNext();
                         updateFloatingBtn();
                     }
                 } 
             } else { 
                 currentSentenceDiv.innerText = "This box is empty. Add some text first."; sentences = []; renderPlaylist(); 
             } 
         }
         function playCurrentBox() { if (openBoxId) playBoxInternal(openBoxId); } 
         function playBoxDirectly(id) { playBoxInternal(id); renderFS(); } 
         
         // Translation & Display Logic 
         let currentNoteSentence = null; 
         function openStickyNoteModal(sentence) { currentNoteSentence = sentence; stickyNoteText.value = stickyNotes[sentence] || ''; stickyNoteModal.classList.add('active'); setTimeout(() => stickyNoteText.focus(), 100); } 
         saveNoteBtn.onclick = () => { 
             let val = stickyNoteText.value.trim(); 
             if(val) stickyNotes[currentNoteSentence] = val; else delete stickyNotes[currentNoteSentence]; 
             localStorage.setItem('app_sticky_notes', JSON.stringify(stickyNotes)); 
             stickyNoteModal.classList.remove('active'); 
             updateActiveSentenceToolbar(); 
         }; 
         function closeStickyModal() { stickyNoteModal.classList.remove('active'); } 
         cancelNoteBtn.onclick = closeStickyModal; closeNoteBtn.onclick = closeStickyModal; stickyNoteModal.addEventListener('click', (e) => { if (e.target === stickyNoteModal) closeStickyModal(); });
         
         stopTranslateBtn.addEventListener('click', () => { abortTranslation = true; });
         
         // NEW GLOBAL DELETE RANGE BUTTON LOGIC
         globalDeleteRangeBtn.addEventListener('click', () => {
             if (!sentences || sentences.length === 0) return;
             updateVisibilityStates();
             const start = startSentenceIndex;
             const end = endSentenceIndex;
             
             let count = end - start + 1;
             if (count <= 0) return;
             
             const rangeVal = rangeInput.value.trim();
             if (!rangeVal) {
                 if (!confirm(`No Play Range specified. This will permanently delete ALL ${count} sentences in this box. Are you sure?`)) return;
             } else {
                 if (!confirm(`Are you sure you want to permanently delete sentences from ${start + 1} to ${end + 1}?`)) return;
             }
             
             const wasPlaying = isPlaying;
             if (isPlaying) togglePlayPause();
             
             for (let i = end; i >= start; i--) {
                 sentences.splice(i, 1);
                 if (isVideoMode) videoSubtitles.splice(i, 1);
             }
             
             if (!isVideoMode) {
                 let newText = sentences.join(' ');
                 let box = findNode(fsTree, activeBoxId);
                 if (box) {
                     setBoxContent(activeBoxId, newText);
                     if (openBoxId === activeBoxId && boxTextarea) boxTextarea.value = newText;
                 }
             }
             
             if (sentenceIndex >= start && sentenceIndex <= end) {
                 sentenceIndex = start;
                 if (sentenceIndex >= sentences.length) sentenceIndex = Math.max(0, sentences.length - 1);
             } else if (sentenceIndex > end) {
                 sentenceIndex -= count;
             }
             
             saveProgress();
             
             if(sentences.length > 0) {
                 updateVisibilityStates();
                 if (!isPlayable(sentenceIndex)) {
                     let nextValid = getFirstPlayableIndex();
                     if(nextValid !== -1) sentenceIndex = nextValid;
                 }
                 updateScreenOnly();
                 renderPlaylist();
                 if (wasPlaying && isPlayable(sentenceIndex)) togglePlayPause();
             } else {
                 resetProgress();
                 currentSentenceDiv.innerText = "Box is now empty.";
                 renderPlaylist();
             }
         });
         
         globalTranslateBtn.addEventListener('click', async () => {
             if (!sentences || sentences.length === 0) return;
             updateVisibilityStates();
             const start = startSentenceIndex; const end = endSentenceIndex;
             const targetLanguage = getTranslationLanguage();
             let allTranslated = true;
             for (let i = start; i <= end; i++) {
                 if (isPlayable(i) && translationState[sentences[i]] !== targetLanguage) { allTranslated = false; break; }
             }
             const targetState = allTranslated ? 'en' : targetLanguage;
             globalTranslateBtn.style.display = 'none'; stopTranslateBtn.style.display = 'flex'; abortTranslation = false;
             let cacheUpdated = false;
             for (let i = start; i <= end; i++) {
                 if (abortTranslation) break;
                 if (!isPlayable(i)) continue;
                 const sentence = sentences[i]; const wrapper = document.getElementById(`playlist-item-${i}`);
                 if (!wrapper) continue;
                 const textSpan = wrapper.querySelector('.sentence-text');
                 if (targetState === 'en') {
                     translationState[sentence] = 'en';
                     if (textSpan) textSpan.innerText = `${i + 1}. ${sentence}`;
                 } else {
                     const cached = getCachedTranslation(sentence, targetLanguage);
                     if (cached) {
                         translationState[sentence] = targetLanguage;
                         if (textSpan) textSpan.innerText = `${i + 1}. ${cached}`;
                     } else {
                         try {
                             const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(targetLanguage)}&dt=t&q=${encodeURIComponent(sentence)}`;
                             const response = await fetch(url);
                             if (response.ok) {
                                 const data = await response.json();
                                 let translatedText = '';
                                 if (data && data[0]) data[0].forEach(part => { if (part[0]) translatedText += part[0]; });
                                 if (translatedText) {
                                     setCachedTranslation(sentence, translatedText, targetLanguage);
                                     translationState[sentence] = targetLanguage;
                                     cacheUpdated = true;
                                     if (textSpan) textSpan.innerText = `${i + 1}. ${translatedText}`;
                                     await new Promise(resolve => setTimeout(resolve, 250));
                                 }
                             }
                         } catch (err) {}
                     }
                 }
             }
             if (cacheUpdated) { localStorage.setItem('app_translation_cache', JSON.stringify(translationCache)); }
             localStorage.setItem('app_translation_state', JSON.stringify(translationState));
             globalTranslateBtn.style.display = 'flex'; globalTranslateBtn.innerHTML = targetState === 'en' ? '🌐' : getTranslationButtonLabel(targetLanguage); stopTranslateBtn.style.display = 'none';
             if (!isPlaying) updateScreenOnly();
         });

         globalHideBtn.addEventListener('click', () => {
             if (!sentences || sentences.length === 0) return;
             updateVisibilityStates();
             const start = startSentenceIndex; const end = endSentenceIndex;
             let allHidden = true;
             for (let i = start; i <= end; i++) {
                 if (!hiddenSentences.has(sentences[i])) { allHidden = false; break; }
             }
             for (let i = start; i <= end; i++) {
                 if (allHidden) hiddenSentences.delete(sentences[i]);
                 else hiddenSentences.add(sentences[i]);
             }
             localStorage.setItem('app_hidden', JSON.stringify(Array.from(hiddenSentences)));
             updateVisibilityStates();
             renderPlaylist();
             if(!isPlaying) updateScreenOnly();
         });
         
         wordChunkInput.addEventListener('input', () => { 
             localStorage.setItem('app_word_chunk', wordChunkInput.value);
             if (isVideoMode) {
                 alert("Word chunking is for standard text mode only (not video).");
                 wordChunkInput.value = '';
                 return;
             }
             sentences = []; 
             if(parseSentencesIfNeeded()) {
                 resetProgress(); 
                 updateVisibilityStates();
                 if (!isPlayable(sentenceIndex)) {
                     let nextValid = getFirstPlayableIndex();
                     if(nextValid !== -1) sentenceIndex = nextValid;
                 }
                 updateScreenOnly();
             }
         });
         
         function parseSentencesIfNeeded() { 
             if (isVideoMode && sentences.length > 0) return true;
             if (!isVideoMode && sentences.length > 0) return true; 
             let box = findNode(fsTree, activeBoxId); 
             if (!box) { currentSentenceDiv.innerHTML = "Select a Box from the File Manager to begin."; return false; } 
             let content = getBoxContent(activeBoxId); let rawText = (content || "").trim(); 
             if (!rawText) { currentSentenceDiv.innerHTML = "Box is empty. Add text to begin."; return false; } 
             if (ruleHideBlock) {
                 let escapeHide = ruleHideBlock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                 let regex = new RegExp(escapeHide + '[\\s\\S]*?' + escapeHide, 'g');
                 rawText = rawText.replace(regex, ' ');
             }
             
             sentences = [];
             let chunkVal = parseInt(wordChunkInput.value);
             
             if (!isNaN(chunkVal) && chunkVal > 0) {
                 let allWords = rawText.split(/\s+/).filter(w => w.trim().length > 0);
                 for (let i = 0; i < allWords.length; i += chunkVal) {
                     sentences.push(allWords.slice(i, i + chunkVal).join(' '));
                 }
             } else {
                 let chunks = ruleHardSplit ? rawText.split(ruleHardSplit) : [rawText];
                 const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' }); 
                 chunks.forEach(chunk => {
                     let cleanedChunk = chunk.trim().replace(/\s+/g, ' ');
                     if (cleanedChunk) {
                         Array.from(segmenter.segment(cleanedChunk)).forEach(s => {
                             if (s.segment.trim().length > 0) sentences.push(s.segment.trim());
                         });
                     }
                 });
             }
             
             renderPlaylist(); 
             return sentences.length > 0; 
         }
         
         function deleteSentencePermanently(index) { 
             if(index < 0 || index >= sentences.length) return; 
             if (!confirm("Permanently delete this sentence?")) return; 
             
             sentences.splice(index, 1); 
             if (isVideoMode) { 
                 videoSubtitles.splice(index, 1); 
             } else { 
                 let newText = sentences.join(' '); 
                 let box = findNode(fsTree, activeBoxId); 
                 if (box) { 
                     setBoxContent(activeBoxId, newText); 
                     if (openBoxId === activeBoxId && boxTextarea) boxTextarea.value = newText; 
                 } 
             } 
             
             if (sentenceIndex >= sentences.length) sentenceIndex = Math.max(0, sentences.length - 1); 
             saveProgress(); renderPlaylist(); 
             
             if(sentences.length > 0) { 
                 updateVisibilityStates(); 
                 if (!isPlayable(sentenceIndex)) {
                     let nextValid = getNextPlayableIndexAfter(sentenceIndex - 1); 
                     if (nextValid === -1) nextValid = getFirstPlayableIndex();
                     if (nextValid !== -1) {
                         jumpToSpecificSentence(nextValid);
                     } else {
                         if (isPlaying) togglePlayPause();
                         updateScreenOnly();
                     }
                 } else {
                     jumpToSpecificSentence(sentenceIndex);
                 }
             } else { 
                 resetProgress(); currentSentenceDiv.innerText = "Box is now empty."; 
             } 
         }
         
         function renderPlaylist() {
             playlistContainer.innerHTML = '';
             const list = getActiveSrtList();
             if (list.length > 0) {
                 playlistSection.style.display = 'block';
                 list.forEach((cue, index) => {
                     const sentence = cue.text;
                     const wrapper = document.createElement('div');
                     wrapper.className = 'sentence-wrapper';
                     wrapper.id = `playlist-item-${activeSrtView}-${index}`;
                     wrapper.dataset.srtView = activeSrtView;
                     wrapper.dataset.srtIndex = String(index);

                     const contentDiv = document.createElement('div');
                     contentDiv.className = 'sentence-content';
                     const topRow = document.createElement('div');
                     topRow.className = 'sentence-top-row';
                     const textSpan = document.createElement('span');
                     textSpan.className = 'sentence-text';

                     let displayText = sentence;
                     if (activeSrtView === 'primary') {
                         const selectedTranslation = getCachedTranslation(sentence);
                         displayText = translationState[sentence] === getTranslationLanguage() && selectedTranslation ? selectedTranslation : sentence;
                     }
                     textSpan.innerText = `${index + 1}. ${displayText}`;
                     topRow.appendChild(textSpan);

                     if (activeSrtView === 'primary' && isBulkDeleteMode) {
                         const checkbox = document.createElement('input');
                         checkbox.type = 'checkbox';
                         checkbox.style.transform = 'scale(1.5)'; checkbox.style.marginLeft = '1rem'; checkbox.style.flexShrink = '0'; checkbox.style.pointerEvents = 'none';
                         checkbox.checked = selectedForDelete.has(index);
                         topRow.appendChild(checkbox);
                         contentDiv.onclick = (e) => { e.stopPropagation(); if (selectedForDelete.has(index)) { selectedForDelete.delete(index); checkbox.checked = false; selectAllCheckbox.checked = false; } else { selectedForDelete.add(index); checkbox.checked = true; } bulkDeleteToggleBtn.innerHTML = `🗑️(${selectedForDelete.size})`; bulkDeleteToggleBtn.style.backgroundColor = '#ef4444'; };
                     } else {
                         contentDiv.onclick = (e) => {
                             if (activeSrtView === 'secondary') {
                                 const primaryIndex = findPrimaryIndexForSecondCue(index);
                                 if (primaryIndex !== -1) jumpToSpecificSentence(primaryIndex);
                             } else {
                                 jumpToSpecificSentence(index);
                             }
                         };
                     }

                     contentDiv.appendChild(topRow);
                     wrapper.appendChild(contentDiv);
                     playlistContainer.appendChild(wrapper);
                 });
                 updateVisibilityStates();
                 updateActiveSentenceToolbar();
             } else {
                 playlistSection.style.display = 'block';
             }
         }

         // --- GLOBAL SENTENCE TOOLBAR LOGIC ---
         function updateActiveSentenceToolbar() {
             const toolbar = document.getElementById('activeSentenceActions');
             if (sentences.length === 0 || sentenceIndex === -1 || sentenceIndex >= sentences.length) {
                 toolbar.style.display = 'none';
                 return;
             }
             toolbar.style.display = 'flex';
             const sentence = sentences[sentenceIndex];

             document.getElementById('actHideBtn').innerText = hiddenSentences.has(sentence) ? '🙈' : '👁️';
             document.getElementById('actStarBtn').innerText = starredSentences.has(sentence) ? '⭐' : '☆';
             document.getElementById('actTranslateBtn').innerText = translationState[sentence] === getTranslationLanguage() ? getTranslationButtonLabel() : '🌐';
             document.getElementById('actNoteBtn').innerHTML = stickyNotes[sentence] ? '📝<span style="color:var(--success);font-size:0.5rem;vertical-align:top">🟢</span>' : '📝';

             const currentCustomVal = customRepeats[sentence];
             const badge = document.getElementById('actRepeatBadge');
             if (currentCustomVal) {
                 badge.innerText = `${currentCustomVal}x`;
                 badge.style.display = 'inline-block';
             } else {
                 badge.style.display = 'none';
             }
         }

         // Action Buttons Event Listeners
         document.getElementById('actJumpBtn').addEventListener('click', () => {
             if (sentences.length === 0 || sentenceIndex === -1) return;
             if(isVideoMode && videoSubtitles[sentenceIndex]) {
                 videoPlayer.currentTime = videoSubtitles[sentenceIndex].start;
                 if(!isPlaying) togglePlayPause();
             } else {
                 openBoxEditor(activeBoxId);
                 setTimeout(() => { 
                     let text = boxTextarea.value; let idx = text.indexOf(sentences[sentenceIndex]); 
                     if (idx !== -1) { 
                         boxTextarea.focus({preventScroll: true}); 
                         boxTextarea.setSelectionRange(idx, idx + sentences[sentenceIndex].length); 
                         const ratio = idx / text.length;
                         const targetScroll = (boxTextarea.scrollHeight * ratio) - (boxTextarea.clientHeight / 3);
                         boxTextarea.scrollTop = Math.max(0, targetScroll);
                     } 
                 }, 100);
             }
         });
         
         document.getElementById('actEditBtn').addEventListener('click', () => {
             if (sentences.length === 0 || sentenceIndex === -1) return;
             let currentText = sentences[sentenceIndex];
             let newText = prompt("Edit active sentence:", currentText);
             if (newText !== null && newText.trim() !== "" && newText.trim() !== currentText) {
                 sentences[sentenceIndex] = newText.trim();
                 if(isVideoMode && videoSubtitles[sentenceIndex]) {
                     videoSubtitles[sentenceIndex].text = newText.trim();
                 } else {
                     let joinedText = sentences.join(' ');
                     setBoxContent(activeBoxId, joinedText);
                     if (openBoxId === activeBoxId && boxTextarea) { boxTextarea.value = joinedText; }
                 }
                 renderPlaylist();
                 if(!isPlaying) updateScreenOnly();
             }
         });
         
         // Ask GPT: copy the number of lines selected in the Line control,
         // starting from the currently active/playing sentence, then open ChatGPT.
         // Example: Line = 50 -> copy current line + the next 49 lines.
         // Line = 20 -> copy current line + the next 19 lines.
         document.getElementById('actGptBtn').addEventListener('click', async () => {
             if (sentences.length === 0 || sentenceIndex === -1) return;

             // Use the same dynamic Line value used by the playback controls.
             // Treat 0/invalid values as one line for a useful GPT action.
             let lineCount = getPlaybackLineCount();
             if (!Number.isFinite(lineCount) || lineCount <= 0) lineCount = 1;

             const startIndex = Math.max(0, sentenceIndex);
             const endIndex = Math.min(sentences.length, startIndex + lineCount);

             // Keep each sentence on its own line so GPT receives the selected
             // subtitle/sentence entries clearly separated.
             const text = sentences
                 .slice(startIndex, endIndex)
                 .filter(line => line && line.trim())
                 .join('\\n');

             if (!text.trim()) return;

             // Finish copying before navigating, especially important on Android.
             try {
                 if (navigator.clipboard && navigator.clipboard.writeText) {
                     await navigator.clipboard.writeText(text);
                 } else {
                     fallbackCopyTextToClipboard(text, document.getElementById('actGptBtn'));
                 }
             } catch (err) {
                 fallbackCopyTextToClipboard(text, document.getElementById('actGptBtn'));
             }

             const encoded = encodeURIComponent(text);
             const isAndroid = /android/i.test(navigator.userAgent);

             if (isAndroid) {
                 // Keep the existing Android ChatGPT intent, including the
                 // selected text so ChatGPT can open with it ready.
                 window.location.href =
                     `intent://chat.openai.com/?q=${encoded}#Intent;scheme=https;package=com.openai.chatgpt;action=android.intent.action.VIEW;end`;
             } else {
                 window.open(`https://chat.openai.com/?q=${encoded}`, '_blank');
             }
         });

         document.getElementById('actHideBtn').addEventListener('click', () => {
             if (sentences.length === 0 || sentenceIndex === -1) return;
             const sentence = sentences[sentenceIndex];
             
             if (hiddenSentences.has(sentence)) {
                 hiddenSentences.delete(sentence);
             } else {
                 hiddenSentences.add(sentence);
             }
             
             localStorage.setItem('app_hidden', JSON.stringify(Array.from(hiddenSentences)));
             updateVisibilityStates();
             renderPlaylist();
             
             if (!isPlayable(sentenceIndex)) {
                 let nextIdx = getNextPlayableIndexAfter(sentenceIndex);
                 if (nextIdx === -1) nextIdx = getFirstPlayableIndex();
                 
                 if (nextIdx !== -1) {
                     jumpToSpecificSentence(nextIdx); 
                 } else {
                     if (isPlaying) togglePlayPause();
                     updateScreenOnly();
                 }
             } else {
                 updateActiveSentenceToolbar();
             }
         });

         document.getElementById('actRepeatBtn').addEventListener('click', () => {
             if (sentences.length === 0 || sentenceIndex === -1) return;
             const sentence = sentences[sentenceIndex];
             let currentCustomVal = customRepeats[sentence];
             let val = prompt(`Set specific repeat count for this sentence:\n(Empty to clear)`, currentCustomVal || '');
             if (val === null) return;
             let parsed = parseInt(val);
             if (!isNaN(parsed) && parsed > 0) customRepeats[sentence] = parsed;
             else delete customRepeats[sentence];
             localStorage.setItem('app_custom_repeats', JSON.stringify(customRepeats));
             updateActiveSentenceToolbar();
             if(!isPlaying) updateScreenOnly();
         });

         document.getElementById('actTranslateBtn').addEventListener('click', async () => {
             if (sentences.length === 0 || sentenceIndex === -1) return;
             const sentence = sentences[sentenceIndex];
             const targetLanguage = getTranslationLanguage();
             const btnElement = document.getElementById('actTranslateBtn');
             const wrapper = document.getElementById(`playlist-item-${sentenceIndex}`);
             let textSpan = wrapper ? wrapper.querySelector('.sentence-text') : null;

             if (translationState[sentence] === targetLanguage) {
                 translationState[sentence] = 'en';
                 localStorage.setItem('app_translation_state', JSON.stringify(translationState));
                 if (textSpan) textSpan.innerText = `${sentenceIndex + 1}. ${sentence}`;
                 btnElement.innerText = '🌐';
             } else {
                 const cached = getCachedTranslation(sentence, targetLanguage);
                 if (cached) {
                     translationState[sentence] = targetLanguage;
                     localStorage.setItem('app_translation_state', JSON.stringify(translationState));
                     if (textSpan) textSpan.innerText = `${sentenceIndex + 1}. ${cached}`;
                     btnElement.innerText = getTranslationButtonLabel(targetLanguage);
                 } else {
                     btnElement.innerText = '⏳';
                     try {
                         const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(targetLanguage)}&dt=t&q=${encodeURIComponent(sentence)}`;
                         const response = await fetch(url);
                         if (!response.ok) throw new Error('Network error');
                         const data = await response.json();
                         let translatedText = '';
                         if (data && data[0]) data[0].forEach(part => { if (part[0]) translatedText += part[0]; });
                         if (translatedText) {
                             setCachedTranslation(sentence, translatedText, targetLanguage);
                             localStorage.setItem('app_translation_cache', JSON.stringify(translationCache));
                             translationState[sentence] = targetLanguage;
                             localStorage.setItem('app_translation_state', JSON.stringify(translationState));
                             if (textSpan) textSpan.innerText = `${sentenceIndex + 1}. ${translatedText}`;
                             btnElement.innerText = getTranslationButtonLabel(targetLanguage);
                         } else throw new Error('Parse error');
                     } catch (err) {
                         btnElement.innerText = '🌐';
                         alert('Translation failed. Please check your internet connection.');
                     }
                 }
             }
         });

         document.getElementById('actStarBtn').addEventListener('click', () => {
             if (sentences.length === 0 || sentenceIndex === -1) return;
             const sentence = sentences[sentenceIndex];
             if (starredSentences.has(sentence)) starredSentences.delete(sentence);
             else starredSentences.add(sentence);
             localStorage.setItem('app_starred', JSON.stringify(Array.from(starredSentences)));
             updateVisibilityStates();
             updateActiveSentenceToolbar();
         });

         document.getElementById('actNoteBtn').addEventListener('click', () => {
             if (sentences.length === 0 || sentenceIndex === -1) return;
             openStickyNoteModal(sentences[sentenceIndex]);
         });

         document.getElementById('actDelBtn').addEventListener('click', () => {
             if (sentences.length === 0 || sentenceIndex === -1) return;
             deleteSentencePermanently(sentenceIndex);
         });

         
         function highlightInBoxEditor() { 
             if (!sentences || sentences.length === 0 || sentenceIndex === -1 || boxEditorView.style.display === 'none') return; 
             const sentence = sentences[sentenceIndex]; 
             const text = boxTextarea.value; 
             const idx = text.indexOf(sentence); 
             if (idx !== -1) { 
                 
                 // Lock the textarea temporarily if actively playing so the mobile keyboard doesn't pop up
                 if (isPlaying) boxTextarea.readOnly = true;
         
                 // Force focus and select the text to make the highlight visible
                 boxTextarea.focus({preventScroll: true});
                 boxTextarea.setSelectionRange(idx, idx + sentence.length); 
                 
                 // Scroll it into view perfectly
                 const ratio = idx / text.length;
                 const targetScroll = (boxTextarea.scrollHeight * ratio) - (boxTextarea.clientHeight / 3);
                 boxTextarea.scrollTop = Math.max(0, targetScroll);
             } 
         }
         
         function highlightActivePlaylistSentence() {
             document.querySelectorAll('.sentence-content').forEach(el => el.classList.remove('active'));
             if (sentences.length > 0 && sentenceIndex !== -1 && sentenceIndex < sentences.length) {
                 let displayIndex = sentenceIndex;
                 if (activeSrtView === 'secondary') {
                     displayIndex = secondSrtSubtitles.findIndex(cue => findPrimaryIndexForSecondCue(secondSrtSubtitles.indexOf(cue)) === sentenceIndex);
                     if (displayIndex === -1 && videoSubtitles[sentenceIndex]) {
                         const primary = videoSubtitles[sentenceIndex];
                         const center = (primary.start + primary.end) / 2;
                         let bestDistance = Infinity;
                         secondSrtSubtitles.forEach((cue, idx) => {
                             const d = Math.abs(((cue.start + cue.end) / 2) - center);
                             if (d < bestDistance) { bestDistance = d; displayIndex = idx; }
                         });
                     }
                 }
                 const activeWrapper = displayIndex >= 0 ? document.getElementById(`playlist-item-${activeSrtView}-${displayIndex}`) : null;
                 if (activeWrapper) {
                     const activeContent = activeWrapper.querySelector('.sentence-content');
                     if(activeContent) activeContent.classList.add('active');
                     activeWrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                 }
                 highlightInBoxEditor();
             }
         }
         function populateVoiceList() { availableVoices = synth.getVoices(); if (availableVoices.length === 0) return; const savedVoice = localStorage.getItem('app_voice'); voiceSelect.innerHTML = ''; availableVoices.forEach((voice) => { const option = document.createElement('option'); option.textContent = `${voice.name} (${voice.lang})`; option.value = voice.name; if (voice.name === savedVoice) option.selected = true; else if (!savedVoice && voice.default) option.selected = true; voiceSelect.appendChild(option); }); } populateVoiceList(); if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = populateVoiceList; voiceSelect.addEventListener('change', () => { localStorage.setItem('app_voice', voiceSelect.value); if (isPlaying) { synth.cancel(); clearTimeout(delayTimeout); clearWordTimers(); setTimeout(() => { if(isPlaying) speakNext(); }, 150); } });
         
         function isPlayable(index) { 
             if (index < startSentenceIndex || index > endSentenceIndex) return false; 
             if (hiddenSentences.has(sentences[index])) return false; 
             if (playStarredOnlyInput.checked && !starredSentences.has(sentences[index])) return false; 
             const minWordsVal = minWordsInput.value.trim();
             if (minWordsVal) {
                 let parts = minWordsVal.split('-'); let minW = parseInt(parts[0], 10); let maxW = parts.length > 1 ? parseInt(parts[1], 10) : Infinity;
                 let count = getWordCount(sentences[index]);
                 if (!isNaN(minW) && minW > 0 && count < minW) return false;
                 if (!isNaN(maxW) && count > maxW) return false;
             }
             const searchInputEl = document.getElementById('sentenceSearchInput');
             if (searchInputEl) {
                 const searchVal = searchInputEl.value.toLowerCase().trim();
                 if (searchVal && !sentences[index].toLowerCase().includes(searchVal)) return false;
             }
             return true; 
         } 
         function getPlayableIndicesArray() { let playable = []; for (let idx = startSentenceIndex; idx <= endSentenceIndex; idx++) if (isPlayable(idx)) playable.push(idx); return playable; } function getFirstPlayableIndex() { playedInCurrentLoop = 0; let arr = getPlayableIndicesArray(); if (arr.length === 0) return -1; if (shuffleInput.checked) { playedInCurrentLoop = 1; return arr[Math.floor(Math.random() * arr.length)]; } return arr[0]; } 
         
         function getNextPlayableIndexAfter(currentIndex) { 
             let arr = getPlayableIndicesArray(); 
             if (arr.length === 0) return -1; 
             if (shuffleInput.checked) { 
                 playedInCurrentLoop++; 
                 if (playedInCurrentLoop >= arr.length) { playedInCurrentLoop = 0; return -1; } 
                 return arr[Math.floor(Math.random() * arr.length)]; 
             } 
             let currentPos = arr.indexOf(currentIndex); 
             if (currentPos === -1) {
                 let nextValid = arr.find(idx => idx > currentIndex);
                 return nextValid !== undefined ? nextValid : -1;
             }
             let skipCount = parseInt(skipIntervalInput.value) || 0; 
             let nextPos = currentPos + 1 + skipCount; 
             if (nextPos >= arr.length) return -1; 
             return arr[nextPos]; 
         }
         
         function updateVisibilityStates() {
             if (!sentences || sentences.length === 0) return;
             let maxIdx = sentences.length - 1; startSentenceIndex = 0; endSentenceIndex = maxIdx;
             const rangeVal = rangeInput.value.trim();
             if (rangeVal) {
                 const parts = rangeVal.split('-').map(p => parseInt(p, 10));
                 if (parts.length === 2) {
                     let s = parts[0] - 1; let e = parts[1] - 1;
                     if (!isNaN(s) && s >= 0 && s <= maxIdx) startSentenceIndex = s;
                     if (!isNaN(e) && e >= startSentenceIndex && e <= maxIdx) endSentenceIndex = e;
                     else if (!isNaN(e) && e > maxIdx) endSentenceIndex = maxIdx;
                 } else if (parts.length === 1 && !isNaN(parts[0])) {
                     let s = parts[0] - 1; if (s >= 0 && s <= maxIdx) { startSentenceIndex = s; endSentenceIndex = s; }
                 }
             }
             const minWordsVal = minWordsInput.value.trim();
             let minW = 0, maxW = Infinity;
             if(minWordsVal) { let parts = minWordsVal.split('-'); minW = parseInt(parts[0], 10); maxW = parts.length > 1 ? parseInt(parts[1], 10) : Infinity; }

             const searchVal = document.getElementById('sentenceSearchInput') ? document.getElementById('sentenceSearchInput').value.toLowerCase().trim() : '';
             const list = getActiveSrtList();

             document.querySelectorAll('.sentence-wrapper').forEach((el, index) => {
                 const cue = list[index];
                 if (!cue) return;
                 const text = cue.text || '';
                 const primaryIndex = activeSrtView === 'secondary' ? findPrimaryIndexForSecondCue(index) : index;
                 let outOfRange = primaryIndex < startSentenceIndex || primaryIndex > endSentenceIndex;
                 if (playStarredOnlyInput.checked && primaryIndex >= 0 && !starredSentences.has(sentences[primaryIndex])) outOfRange = true;
                 if (outOfRange) el.classList.add('out-of-range'); else el.classList.remove('out-of-range');

                 let count = getWordCount(text); let failWords = false;
                 if (!isNaN(minW) && minW > 0 && count < minW) failWords = true;
                 if (!isNaN(maxW) && count > maxW) failWords = true;

                 const failSearch = !!(searchVal && !text.toLowerCase().includes(searchVal));
                 if (failWords || failSearch) el.classList.add('filtered-out'); else el.classList.remove('filtered-out');
             });
         }

         // Event listeners for Settings
         function applyTheme(isDark) { if (isDark) { document.documentElement.classList.add('dark-theme'); document.body.classList.add('dark-theme'); themeToggleBtn.innerText = "☀️"; } else { document.documentElement.classList.remove('dark-theme'); document.body.classList.remove('dark-theme'); themeToggleBtn.innerText = "🌙"; } } themeToggleBtn.addEventListener('click', () => { const isDark = !document.body.classList.contains('dark-theme'); applyTheme(isDark); localStorage.setItem('app_theme', isDark ? 'dark' : 'light'); }); openSettingsBtn.addEventListener('click', () => settingsModal.classList.add('active')); closeSettingsBtn.addEventListener('click', () => settingsModal.classList.remove('active')); settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('active'); });
         
         // --- Backup & Restore System (Export/Import) ---
         exportBtn.addEventListener('click', async () => {
             exportBtn.innerHTML = '⏳'; 
             try {
                 let backup = {
                     localStorage: {}
                 };
                 
                 // Only backup fs_tree and box contents (excluding settings, video, srt)
                 const fsTreeData = localStorage.getItem('app_fs_tree');
                 if (fsTreeData) backup.localStorage['app_fs_tree'] = fsTreeData;
                 
                 for (let i = 0; i < localStorage.length; i++) {
                     let key = localStorage.key(i);
                     if (key && key.startsWith('app_box_content_')) {
                         backup.localStorage[key] = localStorage.getItem(key);
                     }
                 }
                 
                 const dataStr = JSON.stringify(backup);
                 const blob = new Blob([dataStr], { type: "application/json" });
                 const url = URL.createObjectURL(blob);
                 
                 const dlAnchorElem = document.createElement('a');
                 dlAnchorElem.setAttribute("href", url);
                 dlAnchorElem.setAttribute("download", "sentence_repeater_files_backup.json");
                 dlAnchorElem.click();
                 // Give the browser time to start the download before releasing
                 // the Blob URL, especially on mobile browsers.
                 setTimeout(() => URL.revokeObjectURL(url), 1000);
                 
             } catch (error) {
                 console.error("Backup failed:", error);
                 alert("Backup failed.");
             }
             exportBtn.innerHTML = '💾';
         });
         
         importBtn.addEventListener('click', () => importInput.click());
         importInput.addEventListener('change', (e) => {
             const file = e.target.files[0];
             if (!file) return;
             const reader = new FileReader();
             reader.onload = async (evt) => {
                 try {
                     const backup = JSON.parse(evt.target.result);
                     
                     // Restore only the specific File System Keys
                     if (backup.localStorage) {
                         for (let key in backup.localStorage) {
                             localStorage.setItem(key, backup.localStorage[key]);
                         }
                     }
                     
                     alert("Files restored successfully! The app will now reload.");
                     location.reload();
                     
                 } catch (error) {
                     console.error("Restore failed:", error);
                     alert("Restore failed. The backup file might be invalid or corrupted.");
                 }
             };
             reader.readAsText(file);
             e.target.value = '';
         });
         
         function loadSettings() { 
             if (localStorage.getItem('app_theme') === 'dark') applyTheme(true); 
             if (localStorage.getItem('app_play_history')) try { playHistory = JSON.parse(localStorage.getItem('app_play_history')); } catch(e){} 
             if (localStorage.getItem('app_delay')) delayInput.value = localStorage.getItem('app_delay'); 
             if (localStorage.getItem('app_word_chunk')) wordChunkInput.value = localStorage.getItem('app_word_chunk');
             if (localStorage.getItem('app_sentence_repeats')) sentenceRepeatInput.value = localStorage.getItem('app_sentence_repeats'); 
             if (localStorage.getItem('app_passage_repeats')) passageRepeatInput.value = localStorage.getItem('app_passage_repeats'); 
             if (localStorage.getItem('app_range')) rangeInput.value = localStorage.getItem('app_range'); 
             if (localStorage.getItem('app_min_words')) minWordsInput.value = localStorage.getItem('app_min_words'); 
             if (localStorage.getItem('app_play_starred_only') === 'true') playStarredOnlyInput.checked = true; 
             if (localStorage.getItem('app_shuffle') === 'true') shuffleInput.checked = true; 
             if (localStorage.getItem('app_skip_interval')) skipIntervalInput.value = localStorage.getItem('app_skip_interval'); 
             
             // --- Translation language: restore saved choice ---
             if (localStorage.getItem('app_translation_language') && translationLanguageSelect) {
                 const savedLanguage = localStorage.getItem('app_translation_language');
                 if ([...translationLanguageSelect.options].some(o => o.value === savedLanguage)) translationLanguageSelect.value = savedLanguage;
             }
             
             // Reload saved translation state. Older versions used 'hi'; that remains compatible.
             if (localStorage.getItem('app_translation_state')) try { translationState = JSON.parse(localStorage.getItem('app_translation_state')); } catch(e){} 
             
             if (localStorage.getItem('app_starred')) try { starredSentences = new Set(JSON.parse(localStorage.getItem('app_starred'))); } catch(e){} 
             if (localStorage.getItem('app_hidden')) try { hiddenSentences = new Set(JSON.parse(localStorage.getItem('app_hidden'))); } catch(e){} 
             if (localStorage.getItem('app_custom_repeats')) try { customRepeats = JSON.parse(localStorage.getItem('app_custom_repeats')); } catch(e){} 
             if (localStorage.getItem('app_sticky_notes')) try { stickyNotes = JSON.parse(localStorage.getItem('app_sticky_notes')); } catch(e){} 
             if (localStorage.getItem('app_translation_cache')) try { translationCache = JSON.parse(localStorage.getItem('app_translation_cache')); } catch(e){} 
             // Migrate the previous cache format (sentence -> Hindi text) to the new language-aware cache.
             if (translationCache && typeof translationCache === 'object') {
                 const migratedCache = {};
                 Object.keys(translationCache).forEach(key => {
                     if (key.includes('::')) migratedCache[key] = translationCache[key];
                     else migratedCache[`hi::${key}`] = translationCache[key];
                 });
                 translationCache = migratedCache;
             }
             if (localStorage.getItem('app_translation_cache')) localStorage.setItem('app_translation_cache', JSON.stringify(translationCache));
             activeSrtView = localStorage.getItem('app_srt_view') === 'secondary' ? 'secondary' : 'primary';
             showSecondSrtCurrentLine = localStorage.getItem('app_show_second_srt') === 'true';
             updateSecondSrtButtonStates();
             if (localStorage.getItem('app_speed')) { speedInput.value = localStorage.getItem('app_speed'); speedValueDisplay.innerText = `${speedInput.value}x`; } 
             if (!localStorage.getItem('app_translation_language')) localStorage.setItem('app_translation_language', getTranslationLanguage());
         }
         
         window.addEventListener('DOMContentLoaded', () => { 
             loadSettings(); loadFS(); renderFS(); updateNowPlaying(); updateSecondSrtButtonStates(); 
             
             // --- BACKGROUND PLAYBACK: Setup Media Session Controls ---
             if ('mediaSession' in navigator) {
                 navigator.mediaSession.setActionHandler('play', () => { if (!isPlaying) togglePlayPause(); });
                 navigator.mediaSession.setActionHandler('pause', () => { if (isPlaying) togglePlayPause(); });
             }
         
             if (activeBoxId && activeBoxId !== 'video_mode') { 
                 let box = findNode(fsTree, activeBoxId); let content = getBoxContent(activeBoxId); 
                 if (box && content && content.trim()) { 
                     if(parseSentencesIfNeeded()) {
                         resetProgress();
                         updateVisibilityStates(); 
                         if (!isPlayable(sentenceIndex)) { 
                             let nearestValid = getFirstPlayableIndex(); 
                             if (nearestValid !== -1) sentenceIndex = nearestValid; 
                         } 
                         updateScreenOnly(); 
                     }
                 } 
             } 
         });
         
         // --- FIX: Restore Audio track when video loads ---
         videoPlayer.addEventListener('timeupdate', () => {
             if (isVideoMode) updateVideoCurrentSubtitleIndicator();
         });

         videoPlayer.addEventListener('loadedmetadata', () => {
             const savedTrack = localStorage.getItem('app_saved_audio_track');
             if (savedTrack !== null && videoPlayer.audioTracks) {
                 const trackIndex = parseInt(savedTrack, 10);
                 if (!isNaN(trackIndex) && trackIndex >= 0 && trackIndex < videoPlayer.audioTracks.length) {
                     for (let i = 0; i < videoPlayer.audioTracks.length; i++) {
                         videoPlayer.audioTracks[i].enabled = (i === trackIndex);
                     }
                 }
             }
         });
         
         // --- FIX: Poll for audio track changes in case native controls alter it ---
         setInterval(() => {
             if (isVideoMode && videoPlayer && videoPlayer.audioTracks) {
                 for (let i = 0; i < videoPlayer.audioTracks.length; i++) {
                     if (videoPlayer.audioTracks[i].enabled) {
                         localStorage.setItem('app_saved_audio_track', i);
                         break;
                     }
                 }
             }
         }, 2000);

         // Add the event listener for the new search input
         sentenceSearchInput.addEventListener('input', () => {
             updateVisibilityStates();
             if (sentences.length > 0 && sentenceIndex >= 0 && !isPlayable(sentenceIndex)) {
                 let nextIdx = getFirstPlayableIndex();
                 if (nextIdx !== -1) {
                     sentenceIndex = nextIdx;
                     saveProgress();
                     if (!isPlaying) updateScreenOnly();
                 } else {
                     if (isPlaying) togglePlayPause();
                     currentSentenceDiv.innerText = "No playable sentences found matching your search.";
                 }
             }
         });

         delayInput.addEventListener('input', () => localStorage.setItem('app_delay', delayInput.value));
         if (lineCountInput) {
             // New Line setting defaults to 1. Older saved values from previous builds
             // are reset once; after the user changes it, their new value is saved normally.
             const lineSettingVersion = 'app_line_count_default_v2';
             if (localStorage.getItem(lineSettingVersion) !== '1') {
                 localStorage.setItem('app_line_count', '1');
                 localStorage.setItem(lineSettingVersion, '1');
             }
             const savedLineCount = parseInt(localStorage.getItem('app_line_count') || '1', 10);
             lineCountInput.value = Number.isFinite(savedLineCount) && savedLineCount >= 0 ? Math.min(savedLineCount, 1000) : 1;
             lineCountInput.addEventListener('input', () => {
                 let value = parseInt(lineCountInput.value, 10);
                 if (!Number.isFinite(value) || value < 0) value = 0;
                 value = Math.min(value, 1000);
                 lineCountInput.value = value;
                 localStorage.setItem('app_line_count', String(value));

                 // Line = 0 intentionally disables subtitle playback.
                 if (value === 0 && isPlaying) {
                     togglePlayPause();
                 }
             });
         }
         translationLanguageSelect.addEventListener('change', () => {
             localStorage.setItem('app_translation_language', translationLanguageSelect.value);
             resetTranslationStatesForNewLanguage();
         });
         sentenceRepeatInput.addEventListener('input', () => { localStorage.setItem('app_sentence_repeats', sentenceRepeatInput.value); if(!isPlaying) updateScreenOnly(); }); passageRepeatInput.addEventListener('input', () => localStorage.setItem('app_passage_repeats', passageRepeatInput.value)); skipIntervalInput.addEventListener('input', () => localStorage.setItem('app_skip_interval', skipIntervalInput.value)); shuffleInput.addEventListener('change', () => { localStorage.setItem('app_shuffle', shuffleInput.checked); if(!isPlaying) { playedInCurrentLoop = 0; updateScreenOnly(); } }); 
         rangeInput.addEventListener('input', () => { localStorage.setItem('app_range', rangeInput.value); updateVisibilityStates(); if(!isPlayable(sentenceIndex)) { let nextIdx = getFirstPlayableIndex(); if (nextIdx !== -1) sentenceIndex = nextIdx; saveProgress(); if(!isPlaying) updateScreenOnly(); } }); 
         minWordsInput.addEventListener('input', () => { localStorage.setItem('app_min_words', minWordsInput.value); updateVisibilityStates(); if (sentences.length > 0 && sentenceIndex >= 0 && !isPlayable(sentenceIndex)) { let nextIdx = getFirstPlayableIndex(); if (nextIdx !== -1) { sentenceIndex = nextIdx; saveProgress(); if (!isPlaying) updateScreenOnly(); } else { if (isPlaying) togglePlayPause(); currentSentenceDiv.innerText = "No playable sentences found matching your filters."; } } });
         playStarredOnlyInput.addEventListener('change', () => { localStorage.setItem('app_play_starred_only', playStarredOnlyInput.checked); updateVisibilityStates(); if (!isPlayable(sentenceIndex)) { let nextIdx = getFirstPlayableIndex(); if (nextIdx !== -1) { sentenceIndex = nextIdx; saveProgress(); if (!isPlaying) updateScreenOnly(); } else { if (isPlaying) togglePlayPause(); currentSentenceDiv.innerText = "No playable sentences found."; } } }); speedInput.addEventListener('input', () => { speedValueDisplay.innerText = `${speedInput.value}x`; localStorage.setItem('app_speed', speedInput.value); if(isVideoMode && videoPlayer) { videoPlayer.playbackRate = parseFloat(speedInput.value) || 1.0; } if (isPlaying && !isVideoMode) { synth.cancel(); clearTimeout(delayTimeout); clearWordTimers(); setTimeout(() => { if(isPlaying) speakNext(); }, 150); } });
         
         function saveProgress() { 
             if (activeBoxId) {
                 localStorage.setItem('app_sentence_index_' + activeBoxId, sentenceIndex); 
             }
         } 
         function getMaxSentenceRepeats(sentenceStr) { if (!sentenceStr) return parseInt(sentenceRepeatInput.value) || 1; let customVal = customRepeats[sentenceStr]; return (customVal !== undefined && customVal !== null) ? customVal : (parseInt(sentenceRepeatInput.value) || 1); }
         function updateScreenOnly() { 
             if (!sentences || sentences.length === 0 || sentenceIndex === -1) return; 
             const sentenceStr = sentences[sentenceIndex]; 
             const maxRepeats = getMaxSentenceRepeats(sentenceStr); 
             progressText.innerText = `Sentence: ${sentenceIndex + 1}/${sentences.length} (Repeat: ${sentenceRepeatCount + 1}/${maxRepeats})`; 
             currentSentenceDiv.innerHTML = renderSentenceWithWords(sentenceStr) + renderSecondSrtCurrentLine();
             stopPauseCountdown(); 
             highlightActivePlaylistSentence();
             updateActiveSentenceToolbar();
         }
         
         function jumpToSpecificSentence(index) { 
             updateVisibilityStates(); 
             if (index < startSentenceIndex || index > endSentenceIndex) { rangeInput.value = ""; localStorage.setItem('app_range', ""); } 
             if (playStarredOnlyInput.checked && !starredSentences.has(sentences[index])) { playStarredOnlyInput.checked = false; localStorage.setItem('app_play_starred_only', false); } 
             updateVisibilityStates(); 
             
             // Track if we wanted it to be playing
             if (!isJumping) targetPlayingState = isPlaying;
             isJumping = true; // Tell the app we are currently skipping
             isPlaying = false; // Temporarily block old callbacks from ruining state
             
             // --- BACKGROUND PLAYBACK: Clean intervals when jumping ---
             synth.cancel(); 
             if (videoPollingFrame) cancelAnimationFrame(videoPollingFrame); 
             if (window.bgVideoInterval) clearInterval(window.bgVideoInterval);
             
             videoPlayer.pause();
             clearTimeout(delayTimeout); clearWordTimers(); 
             sentenceIndex = index; sentenceRepeatCount = 0; playedInCurrentLoop = 0; 
             saveProgress(); 
             
             // Debounce the rapid pen clicks. Wait 250ms for Android TTS to settle!
             if (window.jumpTimeout) clearTimeout(window.jumpTimeout);
             window.jumpTimeout = setTimeout(() => {
                 isJumping = false;
                 if (targetPlayingState) {
                     isPlaying = true;
                     updateFloatingBtn();
                     speakNext();
                 } else {
                     updateFloatingBtn();
                     updateScreenOnly();
                 }
             }, 250); 
         }
         
         // Render each spoken word as its own span so TTS can highlight the exact word currently spoken.
         function renderSentenceWithWords(sentence, lineIndex = null) {
             if (!sentence) return "";
             let html = '';
             const tokens = sentence.split(/(\s+)/);
             let currentIndex = 0;
             let wordIndex = 0;
             tokens.forEach(token => {
                 if (/\S/.test(token)) {
                     const start = currentIndex;
                     const end = currentIndex + token.length;
                     const safe = token.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                     const lineAttr = lineIndex !== null ? ` data-line-index="${lineIndex}"` : '';
                     html += `<span class="word" data-idx="${wordIndex}" data-start="${start}" data-end="${end}"${lineAttr}>${safe}</span>`;
                     wordIndex++;
                 } else {
                     html += token;
                 }
                 currentIndex += token.length;
             });
             return html;
         }

         function highlightWordByIndex(idx, lineIndex = null) {
             currentSentenceDiv.querySelectorAll('.word').forEach(s => s.classList.remove('word-highlight'));
             const target = lineIndex !== null && lineIndex !== undefined
                 ? currentSentenceDiv.querySelector(`.playback-line[data-line-index="${lineIndex}"] .word[data-idx="${idx}"]`)
                 : currentSentenceDiv.querySelector(`.word[data-idx="${idx}"]`);
             if (target) target.classList.add('word-highlight');
         }

         function highlightWordAt(charIndex, lineIndex = null) {
             currentSentenceDiv.querySelectorAll('.word').forEach(s => s.classList.remove('word-highlight'));
             const activeLine = lineIndex !== null && lineIndex !== undefined
                 ? currentSentenceDiv.querySelector(`.playback-line[data-line-index="${lineIndex}"]`)
                 : currentSentenceDiv;
             const spans = activeLine ? activeLine.querySelectorAll('.word') : [];
             let highlighted = false;
             spans.forEach(span => {
                 const start = parseInt(span.dataset.start, 10);
                 const end = parseInt(span.dataset.end, 10);
                 if (!highlighted && charIndex >= start && charIndex < end) {
                     span.classList.add('word-highlight');
                     highlighted = true;
                 }
             });
         }

         function clearWordTimers() {
             wordTimers.forEach(t => clearTimeout(t));
             wordTimers = [];
         }
         function clearWordHighlight() {
             clearWordTimers();
             currentSentenceDiv.querySelectorAll('.word').forEach(s => s.classList.remove('word-highlight'));
         }
         function estimateWordDuration(word, rate) {
             return Math.max(200, (word.length * 60 + 100)) / rate;
         }
         function scheduleWordHighlights(sentence, rate, lineIndex = null) {
             clearWordTimers();
             const words = sentence.split(/\s+/).filter(w => w.length > 0);
             let elapsed = 100;
             words.forEach((word, i) => {
                 const t = setTimeout(() => {
                     if (!boundarySupported) requestAnimationFrame(() => highlightWordByIndex(i, lineIndex));
                 }, elapsed);
                 wordTimers.push(t);
                 elapsed += estimateWordDuration(word, rate);
             });
         }
         
         function resetProgress() { 
             isPlaying = false; 
             boxTextarea.readOnly = false;
             synth.cancel(); 
             if(videoPlayer) videoPlayer.pause(); 
             
             // --- BACKGROUND PLAYBACK: Clear intervals ---
             if (videoPollingFrame) cancelAnimationFrame(videoPollingFrame); 
             if (window.bgVideoInterval) clearInterval(window.bgVideoInterval); 
             
             clearTimeout(delayTimeout); 
             clearWordTimers(); 
             
             /* Sentence Index/tools stay visible at all times. */
             playlistSection.style.display = 'block';
             
             updateVisibilityStates(); 
             
             // Load the specific saved sentence index for this box
             let savedIdx = parseInt(localStorage.getItem('app_sentence_index_' + activeBoxId), 10);
             if (!isNaN(savedIdx) && savedIdx >= 0 && savedIdx < sentences.length) {
                 sentenceIndex = savedIdx;
             } else {
                 sentenceIndex = startSentenceIndex || 0; 
             }

             sentenceRepeatCount = 0; 
             passageRepeatCount = 0; 
             playedInCurrentLoop = 0;
             playbackGroupStartIndex = -1;
             playbackGroupEndIndex = -1;
             saveProgress(); 
             updateFloatingBtn(); 
         }
         
         // --- User-Controlled Dynamic Sentence Pause ---
         // The Delay (seconds) setting is the exact pause used after EVERY
         // sentence/repetition. For example, entering 5 means the app waits
         // exactly 5 seconds before moving to the next sentence. The countdown
         // updates live while the app is waiting.
         function getPlaybackLineCount() {
             const value = parseInt(lineCountInput ? lineCountInput.value : '1', 10);
             if (!Number.isFinite(value) || value < 0) return 0;
             return Math.min(value, 1000);
         }

         // Line = N means exactly N subtitle/sentence entries are handled as one
         // playback group. The group advances sequentially: 1-4, then 5-8, etc.
         // Filters are respected, but no extra entries are pulled in to replace a
         // filtered-out line; the group is based on the actual consecutive indexes.
         function getPlayableGroupIndices(startIndex) {
             const count = getPlaybackLineCount();
             if (count <= 0 || startIndex < 0 || startIndex >= sentences.length) return [];

             const indices = [];
             const maxEnd = Math.min(sentences.length, startIndex + count);
             for (let idx = startIndex; idx < maxEnd; idx++) {
                 if (!isVideoMode || videoSubtitles[idx]) {
                     if (!isVideoMode || isPlayable(idx)) indices.push(idx);
                 }
             }
             return indices;
         }

         function getPlaybackGroupText(startIndex, endIndex) {
             const parts = [];
             for (let i = startIndex; i <= endIndex && i < sentences.length; i++) {
                 if (sentences[i]) parts.push(sentences[i]);
             }
             return parts.join(' ');
         }

         function getPlaybackGroupDisplayHtml(indices) {
             return indices.map((idx) => {
                 const text = sentences[idx] || '';
                 // Word spans are used by TTS only; video keeps the existing subtitle indicator.
                 const wordHtml = renderSentenceWithWords(text, idx);
                 return `<div class="playback-line" data-line-index="${idx}"><span class="video-current-dot is-hidden" aria-hidden="true"></span><span class="playback-line-number">${idx + 1}.</span> ${wordHtml}</div>`;
             }).join('');
         }

         function updateVideoCurrentSubtitleIndicator() {
             if (!isVideoMode || !videoPlayer || !videoSubtitles.length) return;
             const currentTime = videoPlayer.currentTime;
             let activeIndex = -1;
             const visibleLines = currentSentenceDiv.querySelectorAll('.playback-line');
             visibleLines.forEach(el => {
                 const idx = parseInt(el.dataset.lineIndex, 10);
                 const sub = videoSubtitles[idx];
                 const isCurrent = !!sub && currentTime >= sub.start && currentTime < sub.end;
                 el.classList.toggle('video-current', isCurrent);
                 const dot = el.querySelector('.video-current-dot');
                 if (dot) dot.classList.toggle('is-hidden', !isCurrent);
                 if (isCurrent) activeIndex = idx;
             });

             if (showSecondSrtCurrentLine) {
                 if (!currentSentenceDiv.querySelector('.second-srt-current-line')) {
                     const wrapper = document.createElement('div');
                     wrapper.innerHTML = renderSecondSrtCurrentLine();
                     if (wrapper.firstElementChild) currentSentenceDiv.appendChild(wrapper.firstElementChild);
                 }
                 updateSecondSrtCurrentLine();
             }

             const displayIndex = activeSrtView === 'secondary'
                 ? (() => {
                     const found = findSecondSrtAtTime(currentTime);
                     return found ? found.index : -1;
                 })()
                 : activeIndex;

             document.querySelectorAll('.sentence-content').forEach(el => el.classList.remove('active'));
             if (displayIndex !== -1) {
                 const activeWrapper = document.getElementById(`playlist-item-${activeSrtView}-${displayIndex}`);
                 if (activeWrapper) {
                     const activeContent = activeWrapper.querySelector('.sentence-content');
                     if (activeContent) activeContent.classList.add('active');
                 }
             }
         }

         function getAutomaticPauseSeconds() {
             const value = parseFloat(delayInput.value);
             if (!Number.isFinite(value) || value <= 0) return 0;
             return value;
         }

         function stopPauseCountdown() {
             if (pauseTimerInterval) {
                 clearInterval(pauseTimerInterval);
                 pauseTimerInterval = null;
             }
             pauseDeadline = 0;
             if (pauseTimer) {
                 pauseTimer.classList.remove('is-counting');
                 pauseTimer.style.display = 'none';
             }
             if (pauseTimerValue) pauseTimerValue.textContent = '0.0s';
             clearTimeout(delayTimeout);
             delayTimeout = null;
         }

         function updatePauseCountdownDisplay() {
             const remaining = Math.max(0, (pauseDeadline - performance.now()) / 1000);
             if (pauseTimerValue) pauseTimerValue.textContent = `${remaining.toFixed(1)}s`;
             return remaining;
         }

         function startPauseCountdown(seconds, callback) {
             stopPauseCountdown();
             if (!isPlaying || seconds <= 0) {
                 if (isPlaying) callback();
                 return;
             }

             pauseDeadline = performance.now() + (seconds * 1000);
             if (pauseTimer) {
                 pauseTimer.style.display = 'inline-flex';
                 pauseTimer.classList.add('is-counting');
             }
             updatePauseCountdownDisplay();

             pauseTimerInterval = setInterval(() => {
                 if (!isPlaying) {
                     stopPauseCountdown();
                     return;
                 }

                 const remaining = updatePauseCountdownDisplay();
                 if (remaining <= 0) {
                     stopPauseCountdown();
                     callback();
                 }
             }, 50);
         }

         // Core Loop Completion
         function handleSentenceEnd() {
             if (isJumping) return;

             const completedIndex = sentenceIndex;
             const groupEnd = (playbackGroupEndIndex >= completedIndex)
                 ? playbackGroupEndIndex
                 : completedIndex;

             const sentence = sentences[completedIndex];
             const maxSentenceRepeats = getMaxSentenceRepeats(sentence);
             const maxPassageRepeats = parseInt(passageRepeatInput.value) || 1;
             clearWordHighlight();
             sentenceRepeatCount++;

             if (sentenceRepeatCount >= maxSentenceRepeats) {
                 sentenceRepeatCount = 0;
                 let nextIndex = getNextPlayableIndexAfter(groupEnd);

                 if (nextIndex !== -1) {
                     sentenceIndex = nextIndex;
                 } else {
                     passageRepeatCount++;

                     if (passageRepeatCount >= maxPassageRepeats) {
                         isPlaying = false;
                         boxTextarea.readOnly = false;
                         updateFloatingBtn();
                         currentSentenceDiv.innerText = "Finished reading!";
                         progressText.innerText = `Progress: Done`;
                         repeatText.innerText = `Passage Loop: Done`;
                         document.querySelectorAll('.sentence-content').forEach(el => el.classList.remove('active'));
                         sentenceIndex = getFirstPlayableIndex();
                         if (sentenceIndex === -1) sentenceIndex = startSentenceIndex;
                         passageRepeatCount = 0;
                         playbackGroupStartIndex = -1;
                         playbackGroupEndIndex = -1;
                         saveProgress();
                         updateActiveSentenceToolbar();
                         return;
                     } else {
                         let resetIndex = getFirstPlayableIndex();
                         if (resetIndex !== -1) sentenceIndex = resetIndex;
                     }
                 }
                 saveProgress();
             }

             playbackGroupStartIndex = -1;
             playbackGroupEndIndex = -1;

             if (isPlaying) {
                 const pauseSeconds = getAutomaticPauseSeconds();
                 startPauseCountdown(pauseSeconds, speakNext);
             } else {
                 stopPauseCountdown();
                 speakNext();
             }
         }

         function speakNext() {
             if (!isPlaying) return;

             const lineCount = getPlaybackLineCount();
             if (lineCount === 0) {
                 isPlaying = false;
                 stopPauseCountdown();
                 updateFloatingBtn();
                 currentSentenceDiv.innerHTML = '<span style="color:var(--label-color);">Line is set to 0 — subtitle playback is disabled.</span>';
                 return;
             }

             updateVisibilityStates();

             if (!isPlayable(sentenceIndex)) {
                 let fallback = getFirstPlayableIndex();
                 if (fallback !== -1) sentenceIndex = fallback;
                 else {
                     isPlaying = false;
                     updateFloatingBtn();
                     currentSentenceDiv.innerText = "No playable sentences found. Please adjust filters or range.";
                     return;
                 }
             }

             const groupIndices = getPlayableGroupIndices(sentenceIndex);
             if (!groupIndices.length) {
                 const nextIndex = getFirstPlayableIndex();
                 if (nextIndex !== -1 && nextIndex !== sentenceIndex) {
                     sentenceIndex = nextIndex;
                     speakNext();
                 } else {
                     isPlaying = false;
                     updateFloatingBtn();
                     currentSentenceDiv.innerText = 'No playable subtitles found for the selected Line value.';
                 }
                 return;
             }

             const groupStart = groupIndices[0];
             const groupEnd = groupIndices[groupIndices.length - 1];

             playbackGroupStartIndex = groupStart;
             playbackGroupEndIndex = groupEnd;

             const sentence = sentences[groupStart];
             const playbackText = getPlaybackGroupText(groupStart, groupEnd);
             const maxSentenceRepeats = getMaxSentenceRepeats(sentence);
             const maxPassageRepeats = parseInt(passageRepeatInput.value) || 1;

             if (groupStart === groupEnd) {
                 progressText.innerText = `Sentence: ${groupStart + 1}/${sentences.length} (Repeat: ${sentenceRepeatCount + 1}/${maxSentenceRepeats})`;
             } else {
                 progressText.innerText = `Sentence: ${groupStart + 1}-${groupEnd + 1}/${sentences.length} (Repeat: ${sentenceRepeatCount + 1}/${maxSentenceRepeats})`;
             }
             repeatText.innerText = `Passage Loop: ${passageRepeatCount + 1}/${maxPassageRepeats}`;
             currentSentenceDiv.innerHTML = getPlaybackGroupDisplayHtml(groupIndices) + renderSecondSrtCurrentLine();
             highlightActivePlaylistSentence();
             updateActiveSentenceToolbar();

             if (isVideoMode && videoSubtitles[groupStart]) {
                 const startSub = videoSubtitles[groupStart];
                 const endSub = videoSubtitles[groupEnd] || startSub;

                 videoPlayer.pause();
                 videoPlayer.currentTime = startSub.start;
                 videoPlayer.playbackRate = parseFloat(speedInput.value) || 1.0;

                 if ('mediaSession' in navigator) {
                     navigator.mediaSession.metadata = new MediaMetadata({
                         title: groupStart === groupEnd
                             ? `Sentence ${groupStart + 1}/${sentences.length}`
                             : `Sentences ${groupStart + 1}-${groupEnd + 1}/${sentences.length}`,
                         artist: 'Ultimate Sentence Repeater',
                         album: 'Video Active'
                     });
                 }

                 videoPlayer.onseeked = function() {
                     videoPlayer.onseeked = null;
                     if (!isPlaying) return;

                     updateVideoCurrentSubtitleIndicator();
                     const playPromise = videoPlayer.play();
                     if (playPromise !== undefined) {
                         playPromise.then(() => {
                             if (window.bgVideoInterval) clearInterval(window.bgVideoInterval);

                             window.bgVideoInterval = setInterval(() => {
                                 if (!isPlaying) {
                                     clearInterval(window.bgVideoInterval);
                                     return;
                                 }

                                 updateVideoCurrentSubtitleIndicator();

                                 if (videoPlayer.currentTime >= endSub.end) {
                                     clearInterval(window.bgVideoInterval);
                                     videoPlayer.pause();
                                     handleSentenceEnd();
                                 }
                             }, 50);
                         }).catch(e => {
                             console.error("Video play failed:", e);
                             isPlaying = false;
                             updateFloatingBtn();
                             currentSentenceDiv.innerHTML += `<br><br><span style="color: var(--danger); font-weight: bold;">Playback blocked by browser. Please click Play manually to resume.</span>`;
                         });
                     }
                 };
             } else {
                 // TTS: play each selected subtitle separately, one after another,
                 // without inserting the global pause between lines. The pause is
                 // applied only after the complete Line group finishes.
                 let groupPos = 0;

                 const speakGroupLine = () => {
                     if (!isPlaying) return;
                     if (groupPos >= groupIndices.length) {
                         handleSentenceEnd();
                         return;
                     }

                     const idx = groupIndices[groupPos++];
                     const lineText = sentences[idx] || '';
                     const utterance = new SpeechSynthesisUtterance(lineText);
                     const selectedVoice = availableVoices.find(v => v.name === voiceSelect.value);
                     if (selectedVoice) {
                         utterance.voice = selectedVoice;
                         utterance.lang = selectedVoice.lang;
                     } else {
                         utterance.lang = 'en-US';
                     }
                     utterance.rate = parseFloat(speedInput.value) || 1.0;

                     if ('mediaSession' in navigator) {
                         navigator.mediaSession.metadata = new MediaMetadata({
                             title: `Line ${idx + 1}/${sentences.length}`,
                             artist: 'Reading Text',
                             album: 'TTS Active'
                         });
                     }

                     utterance.onstart = () => {
                         boundarySupported = false;
                         currentSentenceDiv.querySelectorAll('.playback-line').forEach(el => el.classList.remove('current-playback-line'));
                         const activeLine = currentSentenceDiv.querySelector(`[data-line-index="${idx}"]`);
                         if (activeLine) activeLine.classList.add('current-playback-line');
                         clearWordTimers();
                         scheduleWordHighlights(lineText, utterance.rate, idx);
                     };
                     utterance.onboundary = (event) => {
                         if (event.name === 'word') {
                             if (!boundarySupported) {
                                 boundarySupported = true;
                                 clearWordTimers();
                             }
                             requestAnimationFrame(() => highlightWordAt(event.charIndex, idx));
                         }
                     };
                     utterance.onend = () => {
                         clearWordHighlight();
                         if (isPlaying) speakGroupLine();
                     };
                     utterance.onerror = (e) => {
                         if (isJumping) return;
                         if (e.error !== 'canceled') {
                             console.error('Synthesis error', e);
                             isPlaying = false;
                             updateFloatingBtn();
                         }
                     };

                     synth.speak(utterance);
                 };

                 speakGroupLine();

             }
         }

         function getCurrentSentenceText() {
             if (sentences.length > 0 && sentenceIndex !== -1 && sentenceIndex < sentences.length) {
                 const sentence = sentences[sentenceIndex];
                 const targetLanguage = getTranslationLanguage();
                 const translated = translationState[sentence] === targetLanguage ? getCachedTranslation(sentence, targetLanguage) : null;
                 return translated || sentence;
             }
             return getBoxContent(activeBoxId) || '';
         }

         function showCopiedFeedback(button = document.getElementById('actCopyBtn')) {
             if (!button) return;
             const orig = button.innerHTML;
             button.innerHTML = "✅";
             setTimeout(() => { button.innerHTML = orig; }, 1500);
         }

         function fallbackCopyTextToClipboard(text, button = document.getElementById('actCopyBtn')) {
             const textArea = document.createElement("textarea");
             textArea.value = text;
             textArea.style.top = "0";
             textArea.style.left = "0";
             textArea.style.position = "fixed";
             textArea.style.opacity = "0";
             document.body.appendChild(textArea);
             textArea.focus();
             textArea.select();
             try {
                 if (document.execCommand('copy')) showCopiedFeedback(button);
             } catch (err) {}
             document.body.removeChild(textArea);
         }

         document.getElementById('actCopyBtn').addEventListener('click', () => {
             const textToCopy = getCurrentSentenceText();
             if (!textToCopy || !textToCopy.trim()) return;

             const button = document.getElementById('actCopyBtn');
             if (!navigator.clipboard) {
                 fallbackCopyTextToClipboard(textToCopy, button);
                 return;
             }

             navigator.clipboard.writeText(textToCopy)
                 .then(() => showCopiedFeedback(button))
                 .catch(() => fallbackCopyTextToClipboard(textToCopy, button));
         }); function updateFloatingBtn() { if (isPlaying) { floatingTtsBtn.innerHTML = '⏸️'; floatingTtsBtn.classList.add('is-playing'); } else { floatingTtsBtn.innerHTML = '▶️'; floatingTtsBtn.classList.remove('is-playing'); } } 
         
         // UNLOCK TEXTAREA WHEN PAUSING
         function togglePlayPause() { 
             if (isPlaying) { 
                 isPlaying = false; 
                 boxTextarea.readOnly = false; // UNLOCK
                 if (isVideoMode) {
                     videoPlayer.pause();
                     
                     // --- BACKGROUND PLAYBACK: Clear intervals ---
                     if (videoPollingFrame) cancelAnimationFrame(videoPollingFrame);
                     if (window.bgVideoInterval) clearInterval(window.bgVideoInterval);
                 } else {
                     synth.cancel();
                 }
                stopKeepAlive();
                releaseWakeLock();
                if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
                 stopPauseCountdown(); clearWordHighlight(); 
             } else { 
                 if (!parseSentencesIfNeeded()) { alert("Please select a valid Box with text first, or upload SRT for video."); return; } 
                isPlaying = true;
                // Started synchronously from this click's user-gesture, so it
                // satisfies the autoplay policy and keeps the tab flagged as
                // "playing audio" once it's minimized or the screen locks.
                silentKeepAlive.play().catch(() => {});
                requestWakeLock();
                if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
                speakNext(); 
             } 
             updateFloatingBtn(); 
         } 
         
         floatingTtsBtn.addEventListener('click', togglePlayPause); setInterval(updateFloatingBtn, 500); 
         window.addEventListener('beforeunload', () => { stopPauseCountdown(); synth.cancel(); videoPlayer.pause(); stopKeepAlive(); releaseWakeLock(); });
         
         // --- FIX: Rehydrate Video and Force Repaint on Foreground Return ---
         // On Android, backgrounding a tab while a large video is loaded often kills
         // the hardware decode/compositor session for that video. The element can
         // come back looking "black"/frozen even though .error, .networkState and
         // .readyState all still report normal — so we can't rely on those signals
         // to decide whether a fix is needed. Instead, ANY time the tab becomes
         // visible again while in video mode, we proactively rebuild the <video>
         // element's source and re-seek. Rebuilding from the Blob we already hold
         // in memory (currentVideoBlob) is a fast, local, reference-only operation —
         // it does not re-read the whole file — so this is safe to do every time,
         // even for very large (500MB+) files. IndexedDB is only used as a fallback
         // if we've lost the in-memory Blob reference (e.g. connection was closed).
         let rehydrateAttempted = false;
         function reloadVideoFromBlob(blob) {
             if (!blob) return;

             let timeToRestore = videoPlayer.currentTime;
             if (isNaN(timeToRestore) || timeToRestore === 0) {
                 if (videoSubtitles && videoSubtitles[sentenceIndex]) {
                     timeToRestore = videoSubtitles[sentenceIndex].start;
                 } else {
                     timeToRestore = 0;
                 }
             }
             const wasPlaying = isPlaying;
             const restoreToken = (window.__videoRestoreToken || 0) + 1;
             window.__videoRestoreToken = restoreToken;

             if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
             currentVideoBlob = blob;
             currentVideoUrl = URL.createObjectURL(blob);
             videoPlayer.src = currentVideoUrl;

             let timeoutId = null;
             const cleanup = () => {
                 videoPlayer.removeEventListener('loadedmetadata', onReady);
                 if (timeoutId) clearTimeout(timeoutId);
             };

             const failRestore = () => {
                 cleanup();
                 if (window.__videoRestoreToken !== restoreToken) return;
                 rehydrateAttempted = false;
                 console.warn('Video metadata did not become ready during restore.');
             };

             const onReady = () => {
                 cleanup();
                 if (window.__videoRestoreToken !== restoreToken) return;
                 try {
                     videoPlayer.currentTime = Math.max(0, timeToRestore);
                 } catch(e) {
                     console.warn('Video seek restore failed:', e);
                 }
                 if (wasPlaying) {
                     const playPromise = videoPlayer.play();
                     if (playPromise !== undefined) {
                         playPromise.catch(() => {
                             isPlaying = false;
                             updateFloatingBtn();
                             currentSentenceDiv.innerHTML += `<br><span style="color:var(--warning); font-size:0.9rem;">(Playback paused by system. Click Play to resume.)</span>`;
                         });
                     }
                 }
                 rehydrateAttempted = false;
             };

             videoPlayer.addEventListener('loadedmetadata', onReady);
             timeoutId = setTimeout(failRestore, 10000);
             videoPlayer.load();
         }

         function rehydrateVideoFromDB() {
             if (rehydrateAttempted) return; // avoid piling up duplicate attempts
             rehydrateAttempted = true;
         
             // Fast path: we already have the Blob in memory, no DB round-trip needed.
             if (currentVideoBlob) {
                 reloadVideoFromBlob(currentVideoBlob);
                 return;
             }
         
             // Fallback path: fetch it from IndexedDB (e.g. after a fresh page load
             // where we haven't cached the Blob reference yet).
             const doFetch = () => {
                 if (!db) {
                     // Connection was closed by the OS while backgrounded — reopen it,
                     // then retry the fetch instead of silently giving up.
                     openDB(() => { doFetch(); });
                     return;
                 }
                 try {
                     const tx = db.transaction('mediaStore', 'readonly');
                     tx.onerror = () => { console.error("Restore tx failed", tx.error); rehydrateAttempted = false; };
                     const req = tx.objectStore('mediaStore').get('video');
                     req.onerror = () => { console.error("Restore req failed", req.error); rehydrateAttempted = false; };
                     req.onsuccess = () => {
                         if (!req.result) { rehydrateAttempted = false; return; }
                         reloadVideoFromBlob(req.result);
                     };
                 } catch (e) {
                     // db.transaction() throws synchronously if the connection is
                     // already closing — reopen and retry once instead of just
                     // logging and leaving the player stuck.
                     console.error("Restore tx failed", e);
                     db = null;
                     openDB(() => { doFetch(); });
                 }
             };
         
             doFetch();
         }
         
         document.addEventListener('visibilitychange', () => {
             if (document.visibilityState === 'hidden') {
                 // **NEW FIX**: Save audio track immediately upon minimizing
                 if (isVideoMode && videoPlayer && videoPlayer.audioTracks) {
                     for (let i = 0; i < videoPlayer.audioTracks.length; i++) {
                         if (videoPlayer.audioTracks[i].enabled) {
                             localStorage.setItem('app_saved_audio_track', i);
                             break;
                         }
                     }
                 }
                // Re-assert the keep-alive track right as we go into the
                // background -- some Android builds momentarily drop audio
                // focus exactly at the hidden transition.
                if (isPlaying) ensureKeepAlivePlaying();
             }
         
             if (document.visibilityState === 'visible' && isVideoMode && currentVideoUrl) {
                 // First try a lightweight repaint/seek. Rebuilding the entire Blob
                 // source on every foreground return can unnecessarily interrupt
                 // playback. Only use the heavier IndexedDB/blob restore when the
                 // video is actually unavailable or clearly broken.
                 const videoBroken = !!videoPlayer.error ||
                     videoPlayer.readyState < 2 ||
                     videoPlayer.videoWidth === 0;
                 if (videoBroken) {
                     rehydrateVideoFromDB();
                 } else if (isPlaying) {
                     const t = videoPlayer.currentTime;
                     requestAnimationFrame(() => {
                         try {
                             if (Math.abs(videoPlayer.currentTime - t) < 0.25) {
                                 videoPlayer.currentTime = t;
                             }
                         } catch(e) {}
                     });
                 }
             }

            if (document.visibilityState === 'visible' && isPlaying) {
                ensureKeepAlivePlaying();
                requestWakeLock();
                // speechSynthesis on Android Chrome frequently gets killed
                // (not just paused) while the tab is hidden, and resume()
                // often comes back silent or garbled -- so if we're still
                // supposed to be playing but nothing is actually speaking,
                // just restart the current sentence cleanly.
                if (!isVideoMode && !synth.speaking && !synth.pending) {
                    synth.cancel();
                    speakNext();
                }
            }
         });
         
         // Also listen for native video stall/error events in case it dies while open
         videoPlayer.addEventListener('error', () => {
             if (isVideoMode) {
                 // --- FIX: instead of just telling the user to refresh, try to
                 // self-heal from the copy saved in IndexedDB right away.
                 if (document.visibilityState === 'visible') {
                     rehydrateVideoFromDB();
                 } else if (isPlaying) {
                     isPlaying = false;
                     updateFloatingBtn();
                     currentSentenceDiv.innerHTML += `<br><span style="color:var(--danger); font-size:0.9rem;">(Video error. Will auto-reload when you return.)</span>`;
                 }
             }
         });
         
         /* --- Interactive Dictionary Engine --- */
         const dictPopup = document.getElementById('dictPopup');
         const dictWord = document.getElementById('dictWord');
         const dictMeaning = document.getElementById('dictMeaning');
         
         document.getElementById('currentSentence').addEventListener('click', async (e) => {
             const wordEl = e.target.closest('.word');
             if(wordEl) {
                 if(isPlaying) togglePlayPause(); 
                 const word = wordEl.innerText.replace(/[^a-zA-Z]/g, '').toLowerCase();
                 if(!word) return;
                 
                 dictPopup.style.display = 'flex';
                 const rect = wordEl.getBoundingClientRect();
                 const popupWidth = 300;
                 let leftPos = rect.left;
                 if (leftPos + popupWidth > window.innerWidth) leftPos = window.innerWidth - popupWidth - 10;
                 dictPopup.style.left = Math.max(10, leftPos) + 'px';
                 dictPopup.style.top = (rect.bottom + 10) + 'px';
                 
                 dictWord.innerText = word;
                 dictMeaning.innerHTML = "<em>Fetching definition...</em>";
                 
                 try {
                     const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
                     if(!res.ok) throw new Error("Not found");
                     const data = await res.json();
                     let meaningsHtml = '';
                     data[0].meanings.slice(0,2).forEach(m => {
                         meaningsHtml += `<strong>${m.partOfSpeech}</strong>: ${m.definitions[0].definition}<br><br>`;
                     });
                     dictMeaning.innerHTML = meaningsHtml;
                 } catch (err) {
                     dictMeaning.innerHTML = "<span style='color:var(--danger)'>Definition not found. Try translating instead.</span>";
                 }
             }
         });
         
         document.addEventListener('click', (e) => {
             if(!e.target.closest('.dict-popup') && !e.target.closest('.word')) {
                 dictPopup.style.display = 'none';
             }
         });
         
         // --- Smart Pen / Keyboard Navigation ---
         document.addEventListener('keydown', (e) => {
             // Only trigger if we have sentences loaded
             if (!sentences || sentences.length === 0) return;
         
             // Ensure the user isn't actively typing inside a text box (like the Search bar or Box Editor)
             const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
             const isArrow = e.key === "ArrowRight" || e.key === "ArrowLeft";
             
             // If typing in an input/textarea (AND the box is NOT readonly), DO NOT hijack arrow keys
             if (isInput && isArrow && !boxTextarea.readOnly) return; 
         
             // Next Sentence (Pen Down / Right Button / PageDown)
             if (e.key === "ArrowRight" || e.key === "PageDown") {
                 e.preventDefault(); 
                 let nextIndex = getNextPlayableIndexAfter(sentenceIndex);
                 if (nextIndex !== -1) jumpToSpecificSentence(nextIndex);
             }
             
             // Previous Sentence (Pen Up / Left Button / PageUp)
             if (e.key === "ArrowLeft" || e.key === "PageUp") {
                 e.preventDefault(); 
                 
                 // Calculate previous playable sentence manually
                 let prevIndex = sentenceIndex - 1;
                 while (prevIndex >= 0 && !isPlayable(prevIndex)) {
                     prevIndex--;
                 }
                 
                 if (prevIndex >= 0) jumpToSpecificSentence(prevIndex);
             }
         });

// --- App protection / Android install support ---
(function(){
  document.addEventListener('contextmenu', function(e){ e.preventDefault(); }, {capture:true});
  let deferredInstallPrompt = null;
  const installBtn = document.getElementById('installAppBtn');
  function placeInstallButton(){
    const actions = document.querySelector('.fs-header .fs-actions');
    if (actions && installBtn && installBtn.parentElement !== actions) actions.appendChild(installBtn);
  }
  document.addEventListener('DOMContentLoaded', placeInstallButton);
  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault(); deferredInstallPrompt = e;
    if (installBtn) installBtn.hidden = false;
    placeInstallButton();
  });
  installBtn.addEventListener('click', async function(){
    if(!deferredInstallPrompt){ alert('Use your browser menu and choose “Add to Home screen” or “Install app”.'); return; }
    deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  });
  window.addEventListener('appinstalled', function(){ deferredInstallPrompt=null; });
})();

// Register service worker for offline/PWA support on HTTPS or localhost.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}


// --- Anti-adblock notice ---
// This detects common content-blocker behaviour by checking whether a harmless
// bait element that blockers commonly hide has been removed/hidden/collapsed.
(function(){
  'use strict';
  const BaitId = 'adblockBait';
  const WarningId = 'adblockWarning';
  const ReloadId = 'adblockReloadBtn';

  function showWarning(){
    const warning = document.getElementById(WarningId);
    if (warning) warning.hidden = false;
    document.documentElement.classList.add('adblock-detected');
    document.body.classList.add('adblock-detected');
  }

  function baitLooksBlocked(){
    const bait = document.getElementById(BaitId);
    if (!bait) return true;
    const style = window.getComputedStyle(bait);
    const rect = bait.getBoundingClientRect();
    return style.display === 'none' ||
           style.visibility === 'hidden' ||
           parseFloat(style.opacity || '1') === 0 ||
           rect.width < 1 || rect.height < 1;
  }

  function checkAdBlocker(){
    // Give extensions a moment to apply their cosmetic filters.
    window.setTimeout(function(){
      if (baitLooksBlocked()) showWarning();
    }, 700);
  }

  function init(){
    const reload = document.getElementById(ReloadId);
    if (reload) reload.addEventListener('click', function(){ window.location.reload(); });
    checkAdBlocker();
    // Re-check once after a short delay because some blockers inject filters later.
    window.setTimeout(checkAdBlocker, 1800);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
