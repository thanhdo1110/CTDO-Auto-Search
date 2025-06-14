let popupPort = null;
let currentSearchTabId = null;
let shouldStop = false;
let isSearching = false;
let currentSearchPromise = null;
let config = {
  minDelay: 10,
  maxDelay: 60,
  apikey: ''
};

// Load config from storage
chrome.storage.local.get('asa_config', (data) => {
  if (data.asa_config) {
    config = data.asa_config;
  }
});

// Listen for config changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.asa_config) {
    config = changes.asa_config.newValue;
  }
});

function randomTypo(word) {
  // 30% xác suất tạo lỗi chính tả
  if (Math.random() > 0.3 || word.length < 4) return word;
  let arr = word.split('');
  const typoType = Math.floor(Math.random() * 3);
  if (typoType === 0 && arr.length > 3) {
    // Đảo 2 ký tự liền kề
    const i = Math.floor(Math.random() * (arr.length - 2)) + 1;
    [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
  } else if (typoType === 1) {
    // Bỏ 1 ký tự ngẫu nhiên
    arr.splice(Math.floor(Math.random() * arr.length), 1);
  } else {
    // Thêm ký tự lạ vào cuối
    arr.push(String.fromCharCode(97 + Math.floor(Math.random() * 26)));
  }
  return arr.join('');
}

function extractKeywords(text) {
  if (!text) return [];
  
  try {
    // Lấy các dòng có thể là từ khóa (bắt đầu bằng -, *, số, hoặc không có dấu câu)
    return text.split('\n')
      .map(line => line.replace(/^[-*\d.\s]+/, '').trim())
      .filter(line => line && !/based on|here are|grouped by|search terms|topic|keywords|suggest/i.test(line) && line.length > 1);
  } catch (error) {
    sendLog('Lỗi khi tách từ khóa: ' + error.message);
    return [];
  }
}

// Lưu log vào storage
function saveLog(msg) {
  chrome.storage.local.get({log: []}, (data) => {
    const newLog = data.log.concat([msg]);
    chrome.storage.local.set({log: newLog});
  });
}

// Gửi log và lưu lại
function sendLog(msg) {
  if (popupPort) {
    popupPort.postMessage({ type: 'log', msg });
  }
  saveLog(msg);
  console.log('[CTDO Auto Search]', msg);
}

// Khi popup kết nối, gửi lại toàn bộ log
chrome.runtime.onConnect.addListener(function(port) {
  if (port.name === 'popup') {
    popupPort = port;
    chrome.storage.local.get({log: []}, (data) => {
      data.log.forEach(msg => port.postMessage({ type: 'log', msg }));
    });
    port.onDisconnect.addListener(() => { popupPort = null; });
  }
});

// const GEMINI_API_KEY = 'xàm';

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startSearch') {
    shouldStop = false;
    isSearching = true;
    processHistoryAndSearch();
    sendResponse({ status: 'started' });
    return true;
  } else if (request.action === 'stopSearch') {
    shouldStop = true;
    isSearching = false;
    
    // Immediately close current tab and cleanup
    if (currentSearchTabId) {
      chrome.tabs.remove(currentSearchTabId).catch(() => {});
      currentSearchTabId = null;
    }
    
    // Cancel any ongoing search
    if (currentSearchPromise) {
      currentSearchPromise = null;
    }
    
    // Force stop all ongoing operations
    chrome.runtime.sendMessage({ action: 'forceStop' });
    
    sendLog('Đã dừng tìm kiếm ngay lập tức.');
    sendResponse({ status: 'stopped' });
    return true;
  }
});

// Simulate human-like typing with random delays and mistakes
async function typeLikeHuman(element, text) {
  // Add random typos (5% chance per character)
  const textWithTypos = text.split('').map(char => {
    if (Math.random() < 0.05) {
      const nearbyKeys = {
        'a': 's', 's': 'a', 'd': 'f', 'f': 'd',
        'e': 'r', 'r': 'e', 't': 'y', 'y': 't',
        'i': 'o', 'o': 'i', 'p': 'o', 'l': 'k',
        'k': 'l', 'j': 'h', 'h': 'j', 'g': 'f',
        'z': 'x', 'x': 'z', 'c': 'v', 'v': 'c',
        'b': 'v', 'n': 'm', 'm': 'n'
      };
      return nearbyKeys[char.toLowerCase()] || char;
    }
    return char;
  }).join('');

  // Type with random delays and occasional pauses
  for (let i = 0; i < textWithTypos.length; i++) {
    if (!isSearching) return;
    
    const char = textWithTypos[i];
    element.value += char;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    
    // Random delay between 50-150ms for each character
    await new Promise(resolve => setTimeout(resolve, Math.random() * 100 + 50));
    
    // Occasionally pause for longer (10% chance)
    if (Math.random() < 0.1) {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 500 + 300));
    }
  }
  
  // Add a small pause after typing (500-1500ms)
  await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
}

// Generate random delay between actions with more human-like patterns
function getRandomDelay() {
  // Convert config values to milliseconds
  const minDelayMs = config.minDelay * 1000;
  const maxDelayMs = config.maxDelay * 1000;
  
  // More human-like delays with occasional longer pauses
  const baseDelay = Math.floor(Math.random() * (maxDelayMs - minDelayMs) + minDelayMs);
  // 20% chance for a longer pause (1-3 minutes)
  if (Math.random() < 0.2) {
    return baseDelay + Math.floor(Math.random() * 120000 + 60000);
  }
  return baseDelay;
}

// Analyze history with Gemini API
async function analyzeHistoryWithGemini(history) {
  if (!config.apikey) {
    sendLog('Lỗi: Chưa cấu hình Gemini API Key. Vui lòng nhập API Key trong cấu hình tiện ích.');
    return null;
  }

  const prompt = `Analyze these browsing history entries and suggest relevant search terms: ${JSON.stringify(history)}`;
  sendLog('Gọi Gemini API để phân tích lịch sử...');
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.apikey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }]
        })
      }
    );
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    sendLog('Đã nhận phản hồi từ Gemini API.');
    const data = await response.json();
    
    if (!data || !data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0] || !data.candidates[0].content.parts[0].text) {
      throw new Error('Gemini API trả về dữ liệu không hợp lệ');
    }
    
    sendLog('JSON trả về từ Gemini:\n' + JSON.stringify(data, null, 2));
    sendLog('Gemini API đề xuất: ' + data.candidates[0].content.parts[0].text);
    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    sendLog('Lỗi khi gọi Gemini API: ' + error.message);
    return null;
  }
}

// Perform automated search
async function performSearch(searchTerm) {
  if (!isSearching) return;
  
  currentSearchPromise = (async () => {
    try {
      sendLog('Chuẩn bị tìm kiếm: ' + searchTerm);
      
      // Update statistics
      chrome.storage.local.get('asa_stats', (data) => {
        const stats = data.asa_stats || { today: 0, total: 0, last: '' };
        const today = new Date().toDateString();
        
        if (stats.last !== today) {
          stats.today = 0;
          stats.last = today;
        }
        
        stats.today++;
        stats.total++;
        chrome.storage.local.set({ asa_stats: stats });
        
        if (popupPort) {
          popupPort.postMessage({ type: 'stats' });
        }
      });

      if (currentSearchTabId) {
        try {
          await chrome.tabs.remove(currentSearchTabId);
        } catch (error) {
          sendLog('Lỗi khi đóng tab cũ: ' + error.message);
        }
      }

      if (!isSearching) return;

      // Create tab in background
      const tab = await chrome.tabs.create({ 
        url: 'https://www.bing.com',
        active: false
      });
      currentSearchTabId = tab.id;
      sendLog('Đã mở tab Bing mới trong background. Chờ trang tải...');
      
      // Random initial wait (3-7 seconds)
      await new Promise(resolve => setTimeout(resolve, Math.random() * 4000 + 3000));

      if (!isSearching) return;

      sendLog('Inject script để nhập từ khóa tìm kiếm...');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (term) => {
          // Add random mouse movements
          function simulateMouseMovement() {
            const event = new MouseEvent('mousemove', {
              clientX: Math.random() * window.innerWidth,
              clientY: Math.random() * window.innerHeight,
              bubbles: true
            });
            document.dispatchEvent(event);
          }

          // Simulate random mouse movements before typing
          for (let i = 0; i < Math.floor(Math.random() * 3) + 2; i++) {
            simulateMouseMovement();
            await new Promise(r => setTimeout(r, Math.random() * 500 + 200));
          }

          const searchBox = document.querySelector('#sb_form_q');
          if (searchBox) {
            // Clear search box with random delay
            searchBox.value = '';
            await new Promise(r => setTimeout(r, Math.random() * 500 + 200));
            
            // Type with human-like behavior
            for (let char of term) {
              // 5% chance of typo
              if (Math.random() < 0.05) {
                const nearbyKeys = {
                  'a': 'sqwz',
                  'b': 'vghn',
                  'c': 'xdfv',
                  'd': 'serfcx',
                  'e': 'wrsdf',
                  'f': 'drtgvc',
                  'g': 'ftyhbv',
                  'h': 'gyujnb',
                  'i': 'ujko',
                  'j': 'huikmn',
                  'k': 'jiolm',
                  'l': 'kop',
                  'm': 'njk',
                  'n': 'bhjm',
                  'o': 'iklp',
                  'p': 'ol',
                  'q': 'wa',
                  'r': 'edft',
                  's': 'awedxz',
                  't': 'rfgy',
                  'u': 'yhji',
                  'v': 'cfgb',
                  'w': 'qase',
                  'x': 'zsdc',
                  'y': 'tghu',
                  'z': 'asx'
                };
                const nearby = nearbyKeys[char.toLowerCase()] || char;
                const typo = nearby[Math.floor(Math.random() * nearby.length)];
                searchBox.value += typo;
                searchBox.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise(r => setTimeout(r, Math.random() * 100 + 50));
                // Correct typo
                searchBox.value = searchBox.value.slice(0, -1) + char;
              } else {
                searchBox.value += char;
              }
              
              searchBox.dispatchEvent(new Event('input', { bubbles: true }));
              
              // Random typing speed
              await new Promise(r => setTimeout(r, Math.random() * 150 + 50));
              
              // Occasional pause while typing (10% chance)
              if (Math.random() < 0.1) {
                await new Promise(r => setTimeout(r, Math.random() * 500 + 200));
              }
            }

            // Pause before pressing enter (800-2000ms)
            await new Promise(r => setTimeout(r, Math.random() * 1200 + 800));
            
            // Simulate mouse movement to search button
            const searchButton = document.querySelector('#search_icon');
            if (searchButton) {
              const rect = searchButton.getBoundingClientRect();
              const event = new MouseEvent('mousemove', {
                clientX: rect.left + Math.random() * rect.width,
                clientY: rect.top + Math.random() * rect.height,
                bubbles: true
              });
              document.dispatchEvent(event);
              await new Promise(r => setTimeout(r, Math.random() * 300 + 200));
            }
            
            searchBox.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              which: 13,
              bubbles: true
            }));
          }
        },
        args: [searchTerm]
      });

      if (!isSearching) return;

      sendLog('Đã thực hiện tìm kiếm trên Bing với từ khóa: ' + searchTerm);

      // Wait for results (4-8 seconds)
      await new Promise(resolve => setTimeout(resolve, Math.random() * 4000 + 4000));

      if (!isSearching) return;

      sendLog('Chuẩn bị lướt web và nhấp link ngẫu nhiên...');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          function randomDelay(min, max) {
            return new Promise(r => setTimeout(r, Math.random() * (max - min) + min));
          }

          // More human-like scroll behavior
          async function scrollLikeHuman() {
            const maxScrolls = Math.floor(Math.random() * 4) + 2;
            let lastScrollTime = Date.now();
            
            for (let i = 0; i < maxScrolls; i++) {
              // Random scroll amount with occasional larger scrolls
              const scrollAmount = Math.random() < 0.2 ? 
                Math.random() * 1000 + 500 : // 20% chance for larger scroll
                Math.random() * 400 + 100;  // Normal scroll
              
              // Simulate mouse movement before scroll
              const event = new MouseEvent('mousemove', {
                clientX: Math.random() * window.innerWidth,
                clientY: Math.random() * window.innerHeight,
                bubbles: true
              });
              document.dispatchEvent(event);
              
              window.scrollBy({
                top: scrollAmount,
                behavior: 'smooth'
              });
              
              // Random pause between scrolls (1-3 seconds)
              await randomDelay(1000, 3000);
              
              // Occasionally scroll back up a bit (40% chance)
              if (Math.random() < 0.4) {
                window.scrollBy({
                  top: -Math.random() * 300,
                  behavior: 'smooth'
                });
                await randomDelay(800, 2000);
              }
              
              // Ensure minimum time between scrolls
              const timeSinceLastScroll = Date.now() - lastScrollTime;
              if (timeSinceLastScroll < 1000) {
                await randomDelay(1000 - timeSinceLastScroll, 2000 - timeSinceLastScroll);
              }
              lastScrollTime = Date.now();
            }
          }

          // Get search results with more natural filtering
          let links = Array.from(document.querySelectorAll('li.b_algo a, .b_algo a'))
            .filter(a => a.href && a.href.startsWith('http'))
            .filter(a => {
              const parent = a.closest('li');
              const text = parent?.textContent?.toLowerCase() || '';
              return !text.includes('sponsored') &&
                     !text.includes('advertisement') &&
                     !text.includes('quảng cáo') &&
                     !text.includes('ad') &&
                     !a.href.includes('bing.com') &&
                     !a.href.includes('microsoft.com');
            });
          
          if (links.length === 0) return;

          // Initial scroll with random pauses
          await scrollLikeHuman();

          // Click 1-3 random links with more natural behavior
          const numClicks = Math.floor(Math.random() * 3) + 1;
          for (let i = 0; i < numClicks; i++) {
            const idx = Math.floor(Math.random() * links.length);
            const link = links[idx];
            
            // Scroll to link with random offset
            const rect = link.getBoundingClientRect();
            const scrollOffset = Math.random() * 150 - 75; // Random offset between -75 and 75
            window.scrollTo({
              top: window.scrollY + rect.top + scrollOffset,
              behavior: 'smooth'
            });
            
            await randomDelay(1000, 2500);
            
            // Simulate mouse hover before click
            const mouseoverEvent = new MouseEvent('mouseover', {
              bubbles: true,
              cancelable: true,
              view: window
            });
            link.dispatchEvent(mouseoverEvent);
            
            await randomDelay(300, 1000);
            
            // Open link in background
            const newTab = window.open(link.href, '_blank');
            if (newTab) {
              newTab.blur();
              window.focus();
            }
            
            // Wait on clicked page with random duration (8-20 seconds)
            await randomDelay(8000, 20000);
            
            // Close the new tab
            if (newTab) {
              newTab.close();
            }
            
            // 60% chance to go back with natural timing
            if (Math.random() < 0.6) {
              window.history.back();
              await randomDelay(2000, 5000);
              await scrollLikeHuman();
            }
          }
        }
      });

      sendLog('Đã lướt web và nhấp link ngẫu nhiên xong.');
    } catch (error) {
      sendLog('Lỗi khi tìm kiếm/lướt web Bing: ' + error.message);
    }
  })();

  await currentSearchPromise;
  currentSearchPromise = null;
}

async function waitWithCountdown(ms) {
  let seconds = Math.floor(ms / 1000);
  for (let i = seconds; i > 0; i--) {
    if (!isSearching) return;
    sendLog(`⏳ Chờ ${i}s trước khi tìm kiếm tiếp...`);
    await new Promise(r => setTimeout(r, 1000));
  }
}

// Main function to process history and perform searches
async function processHistoryAndSearch() {
  if (!isSearching) return;
  
  sendLog('Bắt đầu lấy lịch sử web...');
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  
  const history = await chrome.history.search({
    text: '',
    startTime: oneWeekAgo.getTime(),
    maxResults: 50
  });
  
  if (!isSearching) {
    sendLog('Đã dừng tìm kiếm.');
    return;
  }
  
  sendLog('Đã lấy ' + history.length + ' mục lịch sử. Gửi lên Gemini...');

  const suggestions = await analyzeHistoryWithGemini(history);
  if (!suggestions || !isSearching) {
    sendLog('Không nhận được đề xuất từ Gemini hoặc đã dừng tìm kiếm.');
    return;
  }

  let keywords = extractKeywords(suggestions);
  if (keywords.length === 0) {
    sendLog('Không tách được từ khóa nào từ kết quả Gemini.');
    return;
  }

  keywords = keywords.sort(() => Math.random() - 0.5).map(randomTypo);
  sendLog('Danh sách từ khóa sẽ tìm kiếm: ' + keywords.join(', '));

  for (const suggestion of keywords) {
    if (!isSearching) {
      sendLog('Đã dừng tìm kiếm.');
      break;
    }
    await performSearch(suggestion);
    if (!isSearching) break;
    const delay = getRandomDelay();
    await waitWithCountdown(delay);
  }
  
  if (!isSearching) {
    sendLog('Đã dừng tìm kiếm theo yêu cầu.');
  } else {
    sendLog('Đã hoàn thành tất cả tìm kiếm.');
  }
  isSearching = false;
} 