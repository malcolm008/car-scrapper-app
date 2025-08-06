const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { URLSearchParams } = require('url');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Constants
const BASE_URL = 'https://umvvs.tra.go.tz';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Session handling (like Python's requests.Session())
const axiosInstance = axios.create({
  headers: {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  },
  withCredentials: true
});

// Helper Functions
async function getFreshState() {
  try {
    const response = await axiosInstance.get(BASE_URL);
    const $ = cheerio.load(response.data);
    
    return {
      viewState: $('input#__VIEWSTATE').val(),
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val() || 'CA0B0334',
      eventValidation: $('input#__EVENTVALIDATION').val(),
      makes: $('#MainContent_ddlMake option').map((i, el) => ({
        value: $(el).attr('value'),
        text: $(el).text().trim()
      })).get().filter(opt => opt.value !== '0')
    };
  } catch (error) {
    console.error('Failed to get fresh state:', error.message);
    throw error;
  }
}

async function postWithState(payload, referer = BASE_URL) {
  const state = await getFreshState();
  
  const formData = new URLSearchParams();
  formData.append('__VIEWSTATE', state.viewState);
  formData.append('__VIEWSTATEGENERATOR', state.viewStateGenerator);
  formData.append('__EVENTVALIDATION', state.eventValidation);
  formData.append('__ASYNCPOST', 'true');
  
  // Add the payload
  for (const [key, value] of Object.entries(payload)) {
    formData.append(key, value);
  }

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'User-Agent': USER_AGENT,
    'Origin': BASE_URL,
    'Referer': referer,
    'X-MicrosoftAjax': 'Delta=true',
    'X-Requested-With': 'XMLHttpRequest'
  };

  // Add delay like in Python code
  await new Promise(resolve => setTimeout(resolve, 1500));

  const response = await axiosInstance.post(BASE_URL, formData.toString(), { 
    headers,
    maxRedirects: 0
  });

  return {
    data: response.data,
    newState: {
      viewState: state.viewState,
      viewStateGenerator: state.viewStateGenerator,
      eventValidation: state.eventValidation
    }
  };
}

// API Endpoints
app.get('/api/init', async (req, res) => {
  try {
    const state = await getFreshState();
    res.json({
      success: true,
      data: {
        makes: state.makes,
        tokens: {
          viewState: state.viewState,
          viewStateGenerator: state.viewStateGenerator,
          eventValidation: state.eventValidation
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Initialization failed',
      details: error.message
    });
  }
});

app.post('/api/models', async (req, res) => {
  try {
    const { makeId } = req.body;
    if (!makeId) throw new Error('Make ID is required');

    const { data, newState } = await postWithState({
      'ctl00$ScriptManager1': 'ctl00$MainContent$UpdatePanel1|ctl00$MainContent$ddlMake',
      '__EVENTTARGET': 'ctl00$MainContent$ddlMake',
      'ctl00$MainContent$ddlMake': makeId,
      'ctl00$MainContent$ddlModel': '0',
      'ctl00$MainContent$ddlYear': '0',
      'ctl00$MainContent$ddlCountry': '0',
      'ctl00$MainContent$ddlFuel': '0',
      'ctl00$MainContent$ddlEngine': '0'
    });

    const $ = cheerio.load(data);
    const models = $('#MainContent_ddlModel option').map((i, el) => ({
      value: $(el).attr('value'),
      text: $(el).text().trim()
    })).get().filter(opt => opt.value !== '0');

    if (models.length === 0) {
      // Try alternative parsing like in Python code
      const parts = data.split('|');
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === 'updatePanel' && parts[i+1] === 'MainContent_ddlPanel') {
          const html = parts[i+2];
          const $ = cheerio.load(html);
          models = $('#MainContent_ddlModel option').map((i, el) => ({
            value: $(el).attr('value'),
            text: $(el).text().trim()
          })).get().filter(opt => opt.value !== '0');
          break;
        }
      }
    }

    if (models.length === 0) throw new Error('No models found in response');

    res.json({
      success: true,
      data: {
        models,
        tokens: newState
      }
    });
  } catch (error) {
    console.error('Model fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch models',
      details: error.message
    });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});