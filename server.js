const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { URLSearchParams } = require('url');
const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost', 'https://your-frontend-domain.com'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Constants
const BASE_URL = 'https://umvvs.tra.go.tz';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Helper Functions
async function getFreshPageState() {
  try {
    const { data } = await axios.get(BASE_URL, {
      headers: { 'User-Agent': USER_AGENT }
    });
    
    const $ = cheerio.load(data);
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
    console.error('Failed to get fresh page state:', error.message);
    throw error;
  }
}

async function postWithFreshState(endpoint, payload, referer = BASE_URL) {
  const freshState = await getFreshPageState();
  
  const formData = new URLSearchParams();
  formData.append('__VIEWSTATE', freshState.viewState);
  formData.append('__VIEWSTATEGENERATOR', freshState.viewStateGenerator);
  formData.append('__EVENTVALIDATION', freshState.eventValidation);
  formData.append('__ASYNCPOST', 'true');
  
  // Add the custom payload
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

  await new Promise(resolve => setTimeout(resolve, 1000)); // Delay

  const { data } = await axios.post(BASE_URL, formData.toString(), { 
    headers,
    maxRedirects: 0
  });

  return {
    data,
    tokens: {
      viewState: freshState.viewState,
      viewStateGenerator: freshState.viewStateGenerator,
      eventValidation: freshState.eventValidation
    }
  };
}

// API Endpoints
app.get('/api/init', async (req, res) => {
  try {
    const pageState = await getFreshPageState();
    res.json({
      success: true,
      data: {
        makes: pageState.makes,
        tokens: {
          viewState: pageState.viewState,
          viewStateGenerator: pageState.viewStateGenerator,
          eventValidation: pageState.eventValidation
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

    const { data, tokens } = await postWithFreshState('models', {
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

    if (models.length === 0) throw new Error('No models found in response');

    res.json({
      success: true,
      data: {
        models,
        tokens
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch models',
      details: error.message
    });
  }
});

app.post('/api/dropdown', async (req, res) => {
  try {
    const { type, parentId } = req.body;
    const validTypes = ['years', 'countries', 'fuel-types', 'engines'];
    
    if (!validTypes.includes(type)) {
      throw new Error(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
    }
    if (!parentId) throw new Error('Parent ID is required');

    const controlMap = {
      'years': { target: 'ddlModel', control: 'ddlYear' },
      'countries': { target: 'ddlYear', control: 'ddlCountry' },
      'fuel-types': { target: 'ddlCountry', control: 'ddlFuel' },
      'engines': { target: 'ddlFuel', control: 'ddlEngine' }
    };

    const { target, control } = controlMap[type];
    const { data, tokens } = await postWithFreshState(type, {
      'ctl00$ScriptManager1': `ctl00$MainContent$UpdatePanel1|ctl00$MainContent$${target}`,
      '__EVENTTARGET': `ctl00$MainContent$${target}`,
      [`ctl00$MainContent$${target}`]: parentId,
      [`ctl00$MainContent$${control}`]: '0'
    });

    const $ = cheerio.load(data);
    const items = $(`#MainContent_${control} option`).map((i, el) => ({
      value: $(el).attr('value'),
      text: $(el).text().trim()
    })).get().filter(opt => opt.value !== '0');

    res.json({
      success: true,
      data: {
        [type]: items,
        tokens
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to fetch ${type}`,
      details: error.message
    });
  }
});

// Error Handling
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Available endpoints:');
  console.log('GET  /api/init');
  console.log('POST /api/models');
  console.log('POST /api/dropdown?type=[years|countries|fuel-types|engines]');
});