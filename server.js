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
      eventTarget: $('input#__EVENTTARGET').val() || '',
      eventArgument: $('input#__EVENTARGUMENT').val() || '',
      lastFocus: $('input#__LASTFOCUS').val() || '',
      requestVerificationToken: $('input[name="__RequestVerificationToken"]').val() || '',
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

async function postWithState(payload, currentState, referer = BASE_URL) {
  const formData = new URLSearchParams();
  
  // Add all fields in the EXACT order seen in the network request
  formData.append('ctl00$ctl08', payload['ctl00$ctl08'] || '');
  formData.append('__EVENTTARGET', payload.__EVENTTARGET || '');
  formData.append('__EVENTARGUMENT', '');
  formData.append('__LASTFOCUS', '');
  formData.append('__VIEWSTATE', currentState.viewState);
  formData.append('__VIEWSTATEGENERATOR', currentState.viewStateGenerator);
  formData.append('__EVENTVALIDATION', currentState.eventValidation);
  
  // Add the form fields in the correct order
  formData.append('ctl00$MainContent$ddlMake', payload['ctl00$MainContent$ddlMake'] || '0');
  formData.append('ctl00$MainContent$ddlModel', payload['ctl00$MainContent$ddlModel'] || '0');
  formData.append('ctl00$MainContent$ddlYear', payload['ctl00$MainContent$ddlYear'] || '0');
  formData.append('ctl00$MainContent$ddlCountry', payload['ctl00$MainContent$ddlCountry'] || '0');
  formData.append('ctl00$MainContent$ddlFuel', payload['ctl00$MainContent$ddlFuel'] || '0');
  formData.append('ctl00$MainContent$ddlEngine', payload['ctl00$MainContent$ddlEngine'] || '0');
  
  formData.append('__ASYNCPOST', 'true');

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'User-Agent': USER_AGENT,
    'Origin': BASE_URL,
    'Referer': referer,
    'X-MicrosoftAjax': 'Delta=true',
    'X-Requested-With': 'XMLHttpRequest'
  };

  // Add delay to avoid rate limiting
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    const response = await axiosInstance.post(BASE_URL, formData.toString(), { 
      headers,
      maxRedirects: 0
    });

    return parseAjaxResponse(response.data, currentState);
  } catch (error) {
    console.error('POST request failed:', error.message);
    throw error;
  }
}

function parseAjaxResponse(responseData, currentState) {
  const parts = responseData.split('|');
  const result = {
    viewState: currentState.viewState,
    viewStateGenerator: currentState.viewStateGenerator,
    eventValidation: currentState.eventValidation,
    html: null
  };
  
  // Parse the response parts
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    
    // Check for ViewState updates
    if (part === '__VIEWSTATE') {
      result.viewState = parts[i+1] || currentState.viewState;
      i++; // Skip next part since we've consumed it
    }
    else if (part === '__VIEWSTATEGENERATOR') {
      result.viewStateGenerator = parts[i+1] || currentState.viewStateGenerator;
      i++;
    }
    else if (part === '__EVENTVALIDATION') {
      result.eventValidation = parts[i+1] || currentState.eventValidation;
      i++;
    }
    // Look for the HTML content (either the panel update or select options)
    else if (part.includes('ddlPanel') || part.includes('<select') || part.includes('option')) {
      // The HTML content is typically in the next part
      if (parts[i+1] && (parts[i+1].includes('<select') || parts[i+1].includes('option'))) {
        result.html = parts[i+1];
        i++;
      } else if (part.includes('<select')) {
        result.html = part;
      }
    }
  }

  return {
    data: responseData,
    parsed: result,
    newState: {
      viewState: result.viewState,
      viewStateGenerator: result.viewStateGenerator,
      eventValidation: result.eventValidation,
      eventTarget: '',
      eventArgument: '',
      lastFocus: '',
      requestVerificationToken: currentState.requestVerificationToken
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
    const { makeId, tokens } = req.body;

    if (!makeId) throw new Error('Make ID is required');
    if (!tokens) throw new Error('State tokens are required');

    const payload = {
      'ctl00$ctl08': `ctl00$MainContent$ddlPanel|${req.body.__EVENTTARGET || 'ctl00$MainContent$ddlMake'}`,
      '__EVENTTARGET': 'ctl00$MainContent$ddlMake',
      'ctl00$MainContent$ddlMake': makeId
      // Other fields will default to '0' in postWithState
    };

    const { parsed, newState } = await postWithState(payload, tokens);

    if (!parsed.html) {
      console.log('Full response parts:', parsed.data.split('|'));
      throw new Error('No HTML content in response');
    }

    // Load the HTML and extract models
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
      details: error.message,
      response: error.response?.data // Include response if available
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