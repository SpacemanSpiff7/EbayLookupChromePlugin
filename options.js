// Options page logic for saving/loading API keys

document.addEventListener('DOMContentLoaded', function() {
  const rapidApiKeyInput = document.getElementById('rapidApiKey');
  const openAiKeyInput = document.getElementById('openAiKey');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');

  // Load saved keys on page load
  chrome.storage.sync.get(['rapidApiKey', 'openAiKey'], function(result) {
    if (result.rapidApiKey) {
      rapidApiKeyInput.value = result.rapidApiKey;
    }
    if (result.openAiKey) {
      openAiKeyInput.value = result.openAiKey;
    }
  });

  // Save keys
  saveBtn.addEventListener('click', function() {
    const rapidApiKey = rapidApiKeyInput.value.trim();
    const openAiKey = openAiKeyInput.value.trim();

    if (!rapidApiKey || !openAiKey) {
      showStatus('Please enter both API keys', 'error');
      return;
    }

    chrome.storage.sync.set({
      rapidApiKey: rapidApiKey,
      openAiKey: openAiKey
    }, function() {
      if (chrome.runtime.lastError) {
        showStatus('Error saving: ' + chrome.runtime.lastError.message, 'error');
      } else {
        showStatus('Saved successfully!', 'success');
      }
    });
  });

  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;

    // Clear status after 3 seconds
    setTimeout(function() {
      statusEl.textContent = '';
      statusEl.className = 'status';
    }, 3000);
  }
});
