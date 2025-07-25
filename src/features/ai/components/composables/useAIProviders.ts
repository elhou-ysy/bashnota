import { ref, computed } from 'vue'
import { useAISettingsStore } from '@/features/ai/stores/aiSettingsStore'
import { aiService } from '@/features/ai/services'
import { webLLMDefaultModelService } from '@/features/ai/services/webLLMDefaultModelService'
import type {
  GeminiModelInfo,
  WebLLMModelInfo,
  ProviderConfig,
  GenerationOptions,
  WebLLMInitProgressReport,
} from '@/features/ai/services'
import { logger } from '@/services/logger'
import { toast } from '@/ui/toast'

/**
 * Composable for AI provider functionality
 */
export function useAIProviders() {
  const aiSettings = useAISettingsStore()
  
  // Provider information
  const providers = computed<ProviderConfig[]>(() => aiService.getProviderConfigs())
  const currentProviderId = ref(aiSettings.settings.preferredProviderId)
  
  // Provider states
  const geminiModels = ref<GeminiModelInfo[]>([])
  const webLLMModels = ref<WebLLMModelInfo[]>([])
  const isLoadingGeminiModels = ref(false)
  const isLoadingWebLLMModels = ref(false)
  
  // WebLLM specific state
  const isWebLLMSupported = ref(false)
  const webLLMProgress = ref(0)
  const webLLMError = ref<string | null>(null)
  const currentWebLLMModel = ref<string | null>(null)
  const isCheckingProviders = ref(false)
  
  // Get available providers that can be used right now
  const availableProviders = ref<string[]>([])
  
  /**
   * Initialize providers - can be called from component setup
   */
  const initialize = async (checkOnlyActiveProvider = true) => {
    // Check WebLLM support
    await checkWebLLMSupport()
    
    // Fetch models
    if (isWebLLMSupported.value) {
      await fetchWebLLMModels()
      updateWebLLMState()
    }
    
    await fetchGeminiModels()
    
    // Check provider availability - only check the active provider by default
    await checkAllProviders(checkOnlyActiveProvider)
    
    // Auto-select best available provider on start if needed
    if (aiSettings.settings.autoSelectProvider !== false && !checkOnlyActiveProvider) {
      await selectBestAvailableProvider()
    }
  }
  
  /**
   * Check if WebLLM is supported in the current browser
   */
  const checkWebLLMSupport = async () => {
    try {
      isWebLLMSupported.value = await aiService.isWebLLMSupported()
    } catch (error) {
      logger.error('Error checking WebLLM support:', error)
      isWebLLMSupported.value = false
    }
  }
  
  /**
   * Fetch Gemini models
   */
  const fetchGeminiModels = async () => {
    try {
      const apiKey = aiSettings.getApiKey('gemini')
      if (!apiKey) {
        geminiModels.value = []
        return
      }
      
      isLoadingGeminiModels.value = true
      const models = await aiService.getGeminiModels(apiKey)
      geminiModels.value = models
      return models
    } catch (error) {
      logger.error('Error fetching Gemini models:', error)
      geminiModels.value = []
      return []
    } finally {
      isLoadingGeminiModels.value = false
    }
  }
  
  /**
   * Fetch WebLLM models
   */
  const fetchWebLLMModels = async () => {
    try {
      isLoadingWebLLMModels.value = true
      const models = await aiService.getWebLLMModels()
      webLLMModels.value = models
      return models
    } catch (error) {
      logger.error('Error fetching WebLLM models:', error)
      webLLMModels.value = []
      return []
    } finally {
      isLoadingWebLLMModels.value = false
    }
  }
  
  /**
   * Load a WebLLM model
   */
  const loadWebLLMModel = async (modelName: string) => {
    try {
      logger.info(`[useAIProviders] Starting to load WebLLM model: ${modelName}`)
      isLoadingWebLLMModels.value = true
      webLLMError.value = null

      // Update state before loading to show loading indicator
      updateWebLLMState()

      const progressCallback = (report: WebLLMInitProgressReport) => {
        logger.debug(`[useAIProviders] Progress callback`, report)
        webLLMProgress.value = report.progress
      }

      await aiService.initializeWebLLMModel(modelName, progressCallback)

      // Update WebLLM model state after loading
      updateWebLLMState()

      // Verify the model is actually loaded
      const state = aiService.getWebLLMModelLoadingState()
      if (!state.currentModel || state.currentModel !== modelName) {
        throw new Error(`Model loading verification failed. Expected: ${modelName}, Got: ${state.currentModel}`)
      }
      
      logger.info(`[useAIProviders] WebLLM model ${modelName} loaded and verified successfully`);
      
      toast({
        title: 'Model Loaded',
        description: `WebLLM model ${modelName} loaded successfully.`
      })
      
      // Make sure WebLLM is set as the preferred provider
      aiSettings.setPreferredProvider('webllm')
      
      return true
    } catch (error) {
      logger.error(`Error loading WebLLM model ${modelName}:`, error)
      
      webLLMError.value = error instanceof Error 
        ? error.message 
        : 'Unknown error loading model'
      
      toast({
        title: 'Error',
        description: `Failed to load WebLLM model: ${webLLMError.value}`,
        variant: 'destructive'
      })
      
      return false
    } finally {
      isLoadingWebLLMModels.value = false
      // Final state update
      updateWebLLMState()
    }
  }
  
  /**
   * Set the default model for a provider
   */
  const setDefaultModel = (providerId: string, modelId: string) => {
    try {
      // Get API key if needed for this provider
      const apiKey = providerId === 'gemini' ? aiSettings.getApiKey('gemini') : undefined
      
      // Set the default model
      aiService.setDefaultModel(providerId, modelId, apiKey)
      
      // Save to settings store
      if (providerId === 'gemini') {
        aiSettings.updateSettings({ geminiModel: modelId })
      }
      
      return true
    } catch (error) {
      logger.error(`Error setting default model for ${providerId}:`, error)
      return false
    }
  }
  
  /**
   * Get default generation options based on current settings
   */
  const getDefaultGenerationOptions = (): GenerationOptions => {
    return {
      prompt: '',
      maxTokens: aiSettings.settings.maxTokens,
      temperature: aiSettings.settings.temperature,
      topP: 0.95,
      safetyThreshold: aiSettings.settings.geminiSafetyThreshold
    }
  }
  
  /**
   * Check if a provider is available/connected
   */
  const checkProviderAvailability = async (providerId: string): Promise<boolean> => {
    try {
      // For WebLLM, check if it's supported by the browser
      // We consider WebLLM available if the browser supports it, even if no model is loaded yet
      if (providerId === 'webllm') {
        await checkWebLLMSupport(); // Make sure we have up-to-date support info
        return isWebLLMSupported.value; 
      }
      
      // For Gemini, make sure there's an API key
      if (providerId === 'gemini') {
        const apiKey = aiSettings.getApiKey('gemini')
        if (!apiKey) return false
      }
      
      return await aiService.isProviderAvailable(providerId)
    } catch (error) {
      logger.error(`Error checking availability for provider ${providerId}:`, error)
      return false
    }
  }
  
  /**
   * Check if a provider supports multimodal inputs (images + text)
   */
  const supportsMultimodal = (providerId: string): boolean => {
    return aiService.providerSupportsMultimodal(providerId)
  }
  
  // Get the current WebLLM model loading state
  const updateWebLLMState = () => {
    try {
      const state = aiService.getWebLLMModelLoadingState()
      logger.debug('[useAIProviders] Updating WebLLM state:', state)
      
      isLoadingWebLLMModels.value = state.isLoading
      webLLMProgress.value = state.progress
      webLLMError.value = state.error
      currentWebLLMModel.value = state.currentModel
      
      logger.debug('[useAIProviders] WebLLM state updated. Current model:', currentWebLLMModel.value)
    } catch (error) {
      logger.error('Error getting WebLLM state:', error)
      // Set error state if we can't get the state
      webLLMError.value = 'Failed to get WebLLM state'
      isLoadingWebLLMModels.value = false
    }
  }
  
  // Check all providers and update availability state
  const checkAllProviders = async (checkOnlyCurrentProvider = false) => {
    if (isCheckingProviders.value) return
    
    try {
      isCheckingProviders.value = true
      availableProviders.value = []
      
      // If checkOnlyCurrentProvider is true, only check the current provider
      const providersToCheck = checkOnlyCurrentProvider
        ? providers.value.filter(p => p.id === aiSettings.settings.preferredProviderId)
        : providers.value
      
      for (const provider of providersToCheck) {
        try {
          // Skip checking Ollama provider if it's not the currently selected provider
          // This avoids unnecessary connection attempts that result in timeout errors
          if (provider.id === 'ollama' && provider.id !== aiSettings.settings.preferredProviderId) {
            logger.info('Skipping Ollama availability check as it is not the current provider');
            continue;
          }
          
          const isAvailable = await checkProviderAvailability(provider.id)
          if (isAvailable) {
            availableProviders.value.push(provider.id)
          }
        } catch (error) {
          logger.error(`Error checking provider ${provider.id}:`, error)
          // Continue with other providers even if one fails
        }
      }
      
      // Update WebLLM state as part of checking providers
      updateWebLLMState()
    } catch (error) {
      logger.error('Error checking providers:', error)
    } finally {
      isCheckingProviders.value = false
    }
  }
  
  // Auto-select the best available provider
  const selectBestAvailableProvider = async () => {
    await checkAllProviders()
    
    const currentProvider = aiSettings.settings.preferredProviderId
    const currentProviderAvailable = availableProviders.value.includes(currentProvider)
    
    // If current provider is already available, keep using it
    if (currentProviderAvailable) {
      return currentProvider
    }
    
    // Otherwise select the first available provider, with preference order:
    // 1. WebLLM (if supported and a model is loaded)
    // 2. Ollama (if available)
    // 3. Gemini (if API key is set)
    
    if (availableProviders.value.includes('webllm') && currentWebLLMModel.value) {
      aiSettings.setPreferredProvider('webllm')
      return 'webllm'
    }
    
    if (availableProviders.value.includes('ollama')) {
      aiSettings.setPreferredProvider('ollama')
      return 'ollama'
    }
    
    if (availableProviders.value.includes('gemini')) {
      aiSettings.setPreferredProvider('gemini')
      return 'gemini'
    }
    
    // No available providers, keep the current selection
    return currentProvider
  }
  
  // Handle provider selection with auto-loading for WebLLM
  const selectProvider = async (providerId: string): Promise<boolean> => {
    // If selecting WebLLM, make sure a model is loaded
    if (providerId === 'webllm') {
      try {
        // Check browser support
        if (!isWebLLMSupported.value) {
          logger.warn('WebLLM not supported in this browser');
          toast({
            title: 'Browser Not Supported',
            description: 'Your browser does not support WebGPU required for WebLLM',
            variant: 'destructive'
          });
          return false;
        }
        
        // Check if a model is already loaded
        updateWebLLMState();
        
        if (!currentWebLLMModel.value) {
          // Make sure we have models to choose from
          if (webLLMModels.value.length === 0) {
            logger.info('No WebLLM models available, fetching models...');
            await fetchWebLLMModels();
            
            if (webLLMModels.value.length === 0) {
              toast({
                title: 'No WebLLM Models',
                description: 'Unable to fetch WebLLM models.',
                variant: 'destructive'
              });
              return false;
            }
          }
          
          // No model loaded, try to load the default or first available model
          let modelToLoad = aiSettings.settings.webllmModel;
          
          // If no model is set in settings, try to find a smaller model to load first
          if (!modelToLoad) {
            // Find smallest model by looking for specific keywords
            const smallModels = webLLMModels.value.filter((m: WebLLMModelInfo) => 
              m.id.includes('7b') || 
              m.id.includes('3b') || 
              m.description.includes('7B') ||
              m.description.includes('3B'));
            
            if (smallModels.length > 0) {
              // Prefer instruction tuned models
              const instructModel = smallModels.find((m: WebLLMModelInfo) => 
                m.id.includes('instruct') || 
                m.id.includes('-it') || 
                m.description.includes('Instruction'));
              
              modelToLoad = instructModel ? instructModel.id : smallModels[0].id;
              logger.info(`Selected smaller WebLLM model: ${modelToLoad}`);
            } else if (webLLMModels.value.length > 0) {
              // Just use the first available model
              modelToLoad = webLLMModels.value[0].id;
              logger.info(`Selected first available WebLLM model: ${modelToLoad}`);
            }
          }
          
          if (modelToLoad) {
            logger.info(`Attempting to load WebLLM model: ${modelToLoad}`);
            const success = await loadWebLLMModel(modelToLoad);
            
            // Save the model ID to settings for future use
            if (success) {
              aiSettings.updateSettings({ webllmModel: modelToLoad });
            } else {
              return false;
            }
          } else {
            // No models available to load
            toast({
              title: 'No WebLLM Model',
              description: 'Please select a WebLLM model in settings.',
              variant: 'destructive'
            });
            return false;
          }
        }
      } catch (error) {
        logger.error('Error selecting WebLLM provider:', error);
        toast({
          title: 'Error',
          description: 'Failed to initialize WebLLM',
          variant: 'destructive'
        });
        return false;
      }
    }
    
    // Set the provider
    aiSettings.setPreferredProvider(providerId);
    return true;
  }
  
  // Initialize WebLLM state at creation time (no onMounted needed)
  checkWebLLMSupport().then(() => {
    updateWebLLMState()
    
    // Check if WebLLM is the preferred provider and if so, make sure it's initialized
    if (aiSettings.settings.preferredProviderId === 'webllm') {
      logger.info('WebLLM is the preferred provider, checking state...')
      if (isWebLLMSupported.value) {
        updateWebLLMState()
        if (!currentWebLLMModel.value) {
          logger.info('No WebLLM model loaded, will auto-load on next generation')
        }
      }
      
      // Only check WebLLM availability if it's the preferred provider
      checkAllProviders(true)
    } else {
      // Only check the current provider
      checkAllProviders(true)
    }
  }).catch(error => {
    logger.error('Error during initial WebLLM check:', error)
  })
  
  /**
   * Verify that WebLLM is ready for text generation
   */
  const verifyWebLLMReady = async (): Promise<boolean> => {
    try {
      updateWebLLMState()
      
      if (!isWebLLMSupported.value) {
        logger.warn('[useAIProviders] WebLLM not supported in this browser')
        return false
      }
      
      const state = aiService.getWebLLMModelLoadingState()
      if (!state.currentModel) {
        logger.warn('[useAIProviders] No WebLLM model is currently loaded')
        return false
      }
      
      if (state.isLoading) {
        logger.warn('[useAIProviders] WebLLM model is still loading')
        return false
      }
      
      if (state.error) {
        logger.error('[useAIProviders] WebLLM has an error state:', state.error)
        return false
      }
      
      logger.info(`[useAIProviders] WebLLM is ready with model: ${state.currentModel}`)
      return true
    } catch (error) {
      logger.error('[useAIProviders] Error verifying WebLLM readiness:', error)
      return false
    }
  }

  /**
   * Set the default WebLLM model that will auto-load on requests
   */
  const setDefaultWebLLMModel = (modelId: string) => {
    aiSettings.setWebLLMDefaultModel(modelId)
    webLLMDefaultModelService.saveDefaultModelConfig({ modelId, enabled: true })
    
    toast({
      title: 'Default Model Set',
      description: `${modelId} will auto-load when WebLLM is requested`
    })
  }

  /**
   * Get recommended default models based on current available models
   */
  const getRecommendedDefaultModels = () => {
    return webLLMDefaultModelService.getRecommendedModels(webLLMModels.value)
  }

  /**
   * Auto-select and set a smart default model
   */
  const autoSelectDefaultModel = async () => {
    if (webLLMModels.value.length === 0) {
      await fetchWebLLMModels()
    }

    const bestModel = webLLMDefaultModelService.selectBestDefaultModel(webLLMModels.value)
    
    if (bestModel) {
      setDefaultWebLLMModel(bestModel.id)
      logger.info(`Auto-selected default WebLLM model: ${bestModel.id}`)
      return bestModel
    }
    
    return null
  }

  /**
   * Check if auto-loading should happen and trigger it if needed
   */
  const ensureWebLLMModelLoaded = async (): Promise<boolean> => {
    const state = aiService.getWebLLMModelLoadingState()
    
    // If model is already loaded, we're good
    if (state.currentModel && !state.error) {
      return true
    }

    // Check if we should auto-load
    const settings = aiSettings.getWebLLMSettings()
    if (!settings.autoLoad) {
      return false
    }

    // Get the model to load (either default or selected strategy)
    let modelToLoad = settings.defaultModel

    if (!modelToLoad && settings.autoLoadStrategy) {
      const recommendations = getRecommendedDefaultModels()
      
      switch (settings.autoLoadStrategy) {
        case 'smallest':
          modelToLoad = recommendations.smallest?.id
          break
        case 'fastest':
          modelToLoad = recommendations.fastest?.id
          break
        case 'balanced':
          modelToLoad = recommendations.balanced?.id
          break
        default:
          modelToLoad = recommendations.smallest?.id
      }
    }

    if (modelToLoad) {
      logger.info(`Ensuring WebLLM model is loaded: ${modelToLoad}`)
      try {
        await loadWebLLMModel(modelToLoad)
        return true
      } catch (error) {
        logger.error(`Failed to ensure WebLLM model ${modelToLoad} is loaded:`, error)
        return false
      }
    }

    return false
  }

  return {
    // Properties
    providers,
    currentProviderId,
    geminiModels,
    webLLMModels,
    isLoadingGeminiModels,
    isLoadingWebLLMModels,
    isWebLLMSupported,
    webLLMProgress,
    webLLMError,
    currentWebLLMModel,
    availableProviders,
    
    // Methods
    initialize,
    checkWebLLMSupport,
    fetchGeminiModels,
    fetchWebLLMModels,
    loadWebLLMModel,
    setDefaultModel,
    getDefaultGenerationOptions,
    checkProviderAvailability,
    supportsMultimodal,
    updateWebLLMState,
    checkAllProviders,
    selectBestAvailableProvider,
    selectProvider,
    verifyWebLLMReady,
    
    // Default model management
    setDefaultWebLLMModel,
    getRecommendedDefaultModels,
    autoSelectDefaultModel,
    ensureWebLLMModelLoaded
  }
} 







