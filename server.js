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

// Session handling
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

function parseAjaxResponse(responseData) {
  const parts = responseData.split('|');
  const result = {};
  
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '__VIEWSTATE') {
      result.viewState = parts[i+1];
    } else if (parts[i] === '__VIEWSTATEGENERATOR') {
      result.viewStateGenerator = parts[i+1];
    } else if (parts[i] === '__EVENTVALIDATION') {
      result.eventValidation = parts[i+1];
    } else if (parts[i] === 'updatePanel' && parts[i+1] === 'MainContent_ddlPanel') {
      result.html = parts[i+2];
    }
  }
  
  return result;
}

async function postWithState(payload, currentState, referer = BASE_URL) {
  const formData = new URLSearchParams();
  formData.append('__VIEWSTATE', currentState.viewState);
  formData.append('__VIEWSTATEGENERATOR', currentState.viewStateGenerator);
  formData.append('__EVENTVALIDATION', currentState.eventValidation);
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
    'X-Requested-With': 'XMLHttpRequest',
    'Cache-Control': 'no-cache'
  };

  // Add delay to avoid rate limiting
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    const response = await axiosInstance.post(BASE_URL, formData.toString(), { 
      headers,
      maxRedirects: 0
    });

    const parsed = parseAjaxResponse(response.data);
    
    return {
      data: response.data,
      parsed: parsed,
      newState: {
        viewState: parsed.viewState || currentState.viewState,
        viewStateGenerator: parsed.viewStateGenerator || currentState.viewStateGenerator,
        eventValidation: parsed.eventValidation || currentState.eventValidation
      }
    };
  } catch (error) {
    console.error('POST request failed:', error.message);
    throw error;
  }
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
    const { makeId, tokens } = req.body;
    if (!makeId) throw new Error('Make ID is required');
    if (!tokens) throw new Error('State tokens are required');

    const { parsed, newState } = await postWithState({
      'ctl00$ScriptManager1': 'ctl00$MainContent$UpdatePanel1|ctl00$MainContent$ddlMake',
      '__EVENTTARGET': 'ctl00$MainContent$ddlMake',
      'ctl00$MainContent$ddlMake': makeId,
      'ctl00$MainContent$ddlModel': '0',
      'ctl00$MainContent$ddlYear': '0',
      'ctl00$MainContent$ddlCountry': '0',
      'ctl00$MainContent$ddlFuel': '0',
      'ctl00$MainContent$ddlEngine': '0'
    }, tokens);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const $ = cheerio.load(parsed.html);
    const models = $('#MainContent_ddlModel option').map((i, el) => ({
      value: $(el).attr('value'),
      text: $(el).text().trim()
    })).get().filter(opt => opt.value !== '0');

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

// Add similar endpoints for other dropdowns (years, countries, etc.)

app.post('/api/years', async (req, res) => {
  try {
    const { makeId, modelId, tokens } = req.body;
    if (!makeId || !modelId) throw new Error('Make and Model IDs are required');
    if (!tokens) throw new Error('State tokens are required');

    const { parsed, newState } = await postWithState({
      'ctl00$ScriptManager1': 'ctl00$MainContent$UpdatePanel1|ctl00$MainContent$ddlModel',
      '__EVENTTARGET': 'ctl00$MainContent$ddlModel',
      'ctl00$MainContent$ddlMake': makeId,
      'ctl00$MainContent$ddlModel': modelId,
      'ctl00$MainContent$ddlYear': '0',
      'ctl00$MainContent$ddlCountry': '0',
      'ctl00$MainContent$ddlFuel': '0',
      'ctl00$MainContent$ddlEngine': '0'
    }, tokens);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const $ = cheerio.load(parsed.html);
    const years = $('#MainContent_ddlYear option').map((i, el) => ({
      value: $(el).attr('value'),
      text: $(el).text().trim()
    })).get().filter(opt => opt.value !== '0');

    res.json({
      success: true,
      data: {
        years,
        tokens: newState
      }
    });
  } catch (error) {
    console.error('Year fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch years',
      details: error.message
    });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});