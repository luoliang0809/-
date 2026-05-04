import React, { useState, useRef, useCallback, useEffect } from 'react';
import { UploadCloud, X, Loader2, Copy, CheckCircle2, Image as ImageIcon, Settings, Send, ChevronDown } from 'lucide-react';
import { generateCopyForSingleImage } from './lib/gemini';
import { cn } from './lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import axios from 'axios';

interface UploadedImage {
  id: string;
  file: File;
  previewUrl: string;
}

export interface GeneratedContent {
  direction: string;
  title: string;
  content: string;
  ending: string;
  callToAction: string;
  tags: string;
  imageUrl?: string;
}

export interface WechatAccount {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
}

export default function App() {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [results, setResults] = useState<GeneratedContent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);

  // AI Configuration
  const [selectedModel, setSelectedModel] = useState('gemini-3-flash-preview');
  const [customModel, setCustomModel] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // WeChat Config Dialog
  const [showWechatSettings, setShowWechatSettings] = useState(false);
  const [wechatAccounts, setWechatAccounts] = useState<WechatAccount[]>([]);
  const [batchOffset, setBatchOffset] = useState(0);

  useEffect(() => {
    // Load AI config
    const savedModel = localStorage.getItem('selectedModel');
    const savedCustomModel = localStorage.getItem('customModel');
    const savedApiBaseUrl = localStorage.getItem('apiBaseUrl');
    const savedApiKey = localStorage.getItem('customApiKey');
    if (savedModel) setSelectedModel(savedModel);
    if (savedCustomModel) setCustomModel(savedCustomModel);
    if (savedApiBaseUrl) setApiBaseUrl(savedApiBaseUrl);
    if (savedApiKey) setCustomApiKey(savedApiKey);

    const savedConfig = localStorage.getItem('wechatAccounts');
    if (savedConfig) {
      const parsed = JSON.parse(savedConfig) as WechatAccount[];
      // Ensure we have 50 accounts
      if (parsed.length < 50) {
        const more = Array.from({length: 50 - parsed.length}, (_, i) => ({
          id: String(parsed.length + i),
          name: `公众号 ${parsed.length + i + 1}`,
          appId: '',
          appSecret: ''
        }));
        setWechatAccounts([...parsed, ...more]);
      } else {
        setWechatAccounts(parsed);
      }
    } else {
      setWechatAccounts(Array.from({length: 50}, (_, i) => ({
        id: String(i),
        name: `公众号 ${i + 1}`,
        appId: '',
        appSecret: ''
      })));
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('selectedModel', selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    localStorage.setItem('customModel', customModel);
  }, [customModel]);

  useEffect(() => {
    localStorage.setItem('customApiKey', customApiKey);
  }, [customApiKey]);

  useEffect(() => {
    localStorage.setItem('apiBaseUrl', apiBaseUrl);
  }, [apiBaseUrl]);

  const saveWechatConfig = () => {
    localStorage.setItem('wechatAccounts', JSON.stringify(wechatAccounts));
    setShowWechatSettings(false);
  };
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(Array.from(e.target.files));
    }
    // reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [images]);

  const addFiles = (files: File[]) => {
    const validImages = files.filter(f => f.type.startsWith('image/'));
    if (validImages.length + images.length > 10) {
      setError('最多只能上传 10 张图片');
      return;
    }
    setError(null);
    
    const newImages = validImages.map(file => ({
      id: Math.random().toString(36).substring(7),
      file,
      previewUrl: URL.createObjectURL(file)
    }));
    
    setImages(prev => [...prev, ...newImages]);
  };

  const removeImage = (id: string) => {
    setImages(prev => {
      const filtered = prev.filter(img => img.id !== id);
      const toRemove = prev.find(img => img.id === id);
      if (toRemove) URL.revokeObjectURL(toRemove.previewUrl);
      return filtered;
    });
  };

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  }, [images]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const getEffectiveModel = () => {
    if (selectedModel === 'custom' || selectedModel === 'doubao-custom') return customModel;
    return selectedModel;
  };

  const handleTestConnection = async () => {
    setIsTestingConnection(true);
    setConnectionStatus('idle');
    try {
      const { testConnection } = await import('./lib/gemini');
      const success = await testConnection(customApiKey, getEffectiveModel(), apiBaseUrl);
      setConnectionStatus(success ? 'success' : 'error');
    } catch (err) {
      setConnectionStatus('error');
    } finally {
      setIsTestingConnection(false);
    }
  };

  const handleGenerate = async () => {
    if (images.length === 0) {
      setError('请先上传至少一张图片');
      return;
    }

    setIsGenerating(true);
    setError(null);
    setResults(null);
    setProgress(0);
    setCompletedCount(0);

    try {
      const finalResults: GeneratedContent[] = new Array(images.length);
      const concurrencyLimit = 1; // Change to 1 concurrent API call to avoid rate limits on free tier
      let activeRequests = 0;
      let currentIndex = 0;
      let localCompletedCount = 0;
      let hasError = false;

      await new Promise<void>((resolve, reject) => {
        const runNext = () => {
          if (hasError) return;
          if (localCompletedCount === images.length) {
            resolve();
            return;
          }

          while (activeRequests < concurrencyLimit && currentIndex < images.length) {
            const taskIndex = currentIndex++;
            activeRequests++;
            const img = images[taskIndex];

            (async () => {
              try {
                if (taskIndex > 0) {
                   await new Promise(res => setTimeout(res, 4000)); // 4 second delay between single processing loops to stay safe on free tier
                }
                const base64Img = await new Promise<{ mimeType: string, data: string }>((res, rej) => {
                  const reader = new FileReader();
                  reader.readAsDataURL(img.file);
                  reader.onload = () => {
                    res({
                      mimeType: img.file.type || 'image/jpeg',
                      data: reader.result as string
                    });
                  };
                  reader.onerror = rej;
                });

                const result = await generateCopyForSingleImage(base64Img, {
                  apiKey: customApiKey,
                  model: getEffectiveModel(),
                  apiBaseUrl: apiBaseUrl
                });
                finalResults[taskIndex] = {
                  ...result,
                  imageUrl: img.previewUrl
                };

                localCompletedCount++;
                setCompletedCount(localCompletedCount);
                setProgress(Math.round((localCompletedCount / images.length) * 100));
              } catch (err) {
                hasError = true;
                reject(err);
              } finally {
                activeRequests--;
                runNext();
              }
            })();
          }
        };

        runNext();
      });

      setResults(finalResults.filter(Boolean)); // Output successfully generated content
    } catch (err: any) {
      console.error(err);
      setError(err.message || '生成过程中发生错误，请稍后重试。');
    } finally {
      setIsGenerating(false);
    }
  };

  const syncToWechat = async (data: GeneratedContent, accountId: string) => {
    const account = wechatAccounts.find(a => a.id === accountId);
    if (!account || !account.appId || !account.appSecret) {
      alert(`请先配置【${account?.name || '该公众号'}】的 AppID 和 AppSecret！`);
      setShowWechatSettings(true);
      return;
    }
    
    const contentHtml = `<p>${data.content}</p><p>${data.ending}</p><p>${data.callToAction}</p><p>${data.tags}</p>`;

    try {
      const res = await axios.post('/api/wechat/draft', {
        appId: account.appId,
        appSecret: account.appSecret,
        title: data.title,
        content: contentHtml
      });
      if (res.data.success) {
        alert('已成功发送至微信公众号草稿箱！');
      }
    } catch (err: any) {
      const msg = err.response?.data?.error || err.message;
      alert('同步至微信失败：\n' + msg + '\n\n注：微信接口通常需要正文包含图片素材ID (thumb_media_id)，此demo仅作功能演示。');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans selection:bg-black selection:text-white pb-12">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
              <ImageIcon className="w-5 h-5 text-white" />
            </div>
            <h1 className="font-semibold text-lg tracking-tight">为家乡点赞 <span className="text-gray-400 font-normal">v3.1</span></h1>
          </div>
          <button 
            onClick={() => setShowWechatSettings(true)}
            className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-black transition-colors"
          >
            <Settings className="w-4 h-4" />
            公众号配置
          </button>
        </div>
      </header>

      {/* WeChat Settings Modal */}
      <AnimatePresence>
        {showWechatSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl flex flex-col w-full max-w-6xl shadow-xl overflow-hidden"
              style={{ maxHeight: '90vh' }}
            >
              <div className="flex justify-between items-center p-5 border-b border-gray-100 shrink-0">
                <h3 className="text-lg font-semibold">微信公众号配置 (50组对应)</h3>
                <button onClick={() => setShowWechatSettings(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 bg-gray-50">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {wechatAccounts.map((acc, i) => (
                    <div key={acc.id} className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm space-y-3">
                      <div className="flex items-center gap-2 border-b border-gray-100 pb-2">
                        <span className="w-6 h-6 rounded-full bg-black text-white flex items-center justify-center text-xs font-bold leading-none">{i + 1}</span>
                        <input 
                          type="text" 
                          value={acc.name}
                          onChange={e => {
                            const newAccs = [...wechatAccounts];
                            newAccs[i].name = e.target.value;
                            setWechatAccounts(newAccs);
                          }}
                          className="flex-1 font-medium text-sm text-gray-900 border-none p-0 focus:ring-0 outline-none"
                          placeholder={`公众号 ${i + 1} 名称`}
                        />
                      </div>
                      <div>
                        <input 
                          type="text" 
                          value={acc.appId}
                          onChange={e => {
                            const newAccs = [...wechatAccounts];
                            newAccs[i].appId = e.target.value;
                            setWechatAccounts(newAccs);
                          }}
                          className="w-full px-3 py-2 text-xs border border-gray-300 rounded-lg focus:ring-1 focus:ring-black focus:border-black outline-none transition-colors font-mono"
                          placeholder="AppID"
                        />
                      </div>
                      <div>
                        <input 
                          type="password" 
                          value={acc.appSecret}
                          onChange={e => {
                            const newAccs = [...wechatAccounts];
                            newAccs[i].appSecret = e.target.value;
                            setWechatAccounts(newAccs);
                          }}
                          className="w-full px-3 py-2 text-xs border border-gray-300 rounded-lg focus:ring-1 focus:ring-black focus:border-black outline-none transition-colors font-mono"
                          placeholder="AppSecret"
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="bg-blue-50 text-blue-800 text-xs p-3 rounded-lg border border-blue-100 leading-relaxed mt-5">
                  提示：共支持 50 组公众号配置。推文生成后将按图片顺序自动对应到相应的公众号。需在各微信公众平台配置白名单IP，才能正常调用草稿箱API。
                </div>
              </div>
              <div className="p-5 border-t border-gray-100 bg-white shrink-0">
                <button 
                  onClick={saveWechatConfig}
                  className="w-full bg-black text-white py-2.5 rounded-xl font-medium hover:bg-gray-800 transition-colors"
                >
                  保存配置
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 flex flex-col lg:flex-row gap-8">
        
        {/* Left Column - Input Area */}
        <div className="w-full lg:w-1/3 xl:w-1/4 shrink-0 space-y-6">
          <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100">
            <div className="mb-4">
              <h2 className="text-base font-semibold leading-tight text-gray-900">上传图片素材</h2>
              <p className="text-sm text-gray-500 mt-1">支持拖拽，最多一次可上传 10 张图片</p>
            </div>

            {/* AI Settings Section */}
            <div className="mb-6 p-4 bg-gray-50/50 rounded-xl border border-gray-100 space-y-4">
              <div className="flex items-center gap-2 mb-1">
                <Settings className="w-4 h-4 text-gray-700" />
                <h3 className="text-sm font-semibold text-gray-900">AI 模型设置</h3>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1.5 ml-1">选择模型</label>
                  <div className="relative">
                    <select 
                      value={selectedModel}
                      onChange={e => setSelectedModel(e.target.value)}
                      className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-black outline-none appearance-none cursor-pointer pr-8"
                    >
                      <optgroup label="Google Gemini">
                        <option value="gemini-flash-latest">Gemini Flash Fast (最新快速度)</option>
                        <option value="gemini-3-flash-preview">Gemini 3 Flash (主流推荐)</option>
                        <option value="gemini-3.1-flash-lite-preview">Gemini 3.1 Flash Lite (轻量级)</option>
                        <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (复杂逻辑强)</option>
                      </optgroup>
                      <optgroup label="OpenAI">
                        <option value="gpt-4o">GPT-4o</option>
                        <option value="gpt-4o-mini">GPT-4o Mini</option>
                      </optgroup>
                      <optgroup label="Anthropic (Claude)">
                        <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                      </optgroup>
                      <optgroup label="字节跳动 (豆包)">
                        <option value="doubao-custom">豆包 (输入接入点 Endpoint)</option>
                      </optgroup>
                      <option value="custom">自定义模型...</option>
                    </select>
                    <ChevronDown className="w-4 h-4 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  </div>
                </div>

                {(selectedModel === 'custom' || selectedModel === 'doubao-custom') && (
                  <div>
                    <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1.5 ml-1">
                      {selectedModel === 'doubao-custom' ? '豆包 Endpoint (例如: ep-xxxx)' : '模型名称'}
                    </label>
                    <input 
                      type="text"
                      value={customModel}
                      onChange={e => setCustomModel(e.target.value)}
                      placeholder={selectedModel === 'doubao-custom' ? "ep-2024..." : "如: deepseek-chat"}
                      className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-black outline-none"
                    />
                  </div>
                )}

                {(!selectedModel.includes('gemini') || apiBaseUrl) && (
                  <div>
                    <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1.5 ml-1">
                      API Base URL
                      <span className="text-gray-400 font-normal ml-1">(需要配置支持跨域的代理，如OneAPI)</span>
                    </label>
                    <input 
                      type="text"
                      value={apiBaseUrl}
                      onChange={e => setApiBaseUrl(e.target.value)}
                      placeholder="如: https://api.openai.com/v1 或代理地址"
                      className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-black outline-none"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1.5 ml-1">API KEY</label>
                  <input 
                    type="password"
                    value={customApiKey}
                    onChange={e => setCustomApiKey(e.target.value)}
                    placeholder="请输入你的 API Key"
                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-black outline-none"
                  />
                </div>
                <div className="pt-1">
                  <button
                    onClick={handleTestConnection}
                    disabled={isTestingConnection}
                    className={cn(
                      "w-full py-1.5 px-3 rounded-lg text-xs font-medium border transition-all flex items-center justify-center gap-2",
                      connectionStatus === 'success' ? "bg-green-50 border-green-200 text-green-700" :
                      connectionStatus === 'error' ? "bg-red-50 border-red-200 text-red-700" :
                      "bg-white border-gray-200 text-gray-700 hover:bg-gray-50 active:bg-gray-100"
                    )}
                  >
                    {isTestingConnection ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : null}
                    {connectionStatus === 'success' ? '连接成功 ✓' : 
                     connectionStatus === 'error' ? '连接失败 ✗' : 
                     '测试 API 连接'}
                  </button>
                </div>
              </div>
            </div>

            {/* Upload Zone */}
            <div 
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors duration-200",
                "border-gray-200 hover:border-black hover:bg-gray-50"
              )}
            >
              <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center mb-3 text-gray-500">
                <UploadCloud className="w-5 h-5" />
              </div>
              <p className="text-sm font-medium text-gray-900">点击或将图片拖拽至此处</p>
              <p className="text-xs text-gray-500 mt-1">JPG, PNG, WEBP (最高 10 张)</p>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange}
                multiple 
                accept="image/*" 
                className="hidden" 
              />
            </div>

            {/* Image Previews */}
            {images.length > 0 && (
              <div className="mt-5">
                <div className="flex items-center justify-between mb-3 text-sm">
                  <span className="font-medium">已选择 {images.length} 张图片</span>
                  <button 
                    onClick={(e) => { e.stopPropagation(); setImages([]); }}
                    className="text-gray-500 hover:text-red-600 transition-colors"
                  >
                    清空全部
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <AnimatePresence>
                    {images.map(img => (
                      <motion.div 
                        key={img.id}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        className="relative aspect-square rounded-lg overflow-hidden group bg-gray-100 border border-gray-200"
                      >
                        <img src={img.previewUrl} alt="Preview" className="w-full h-full object-cover" />
                        <button
                          onClick={(e) => { e.stopPropagation(); removeImage(img.id); }}
                          className="absolute top-1 right-1 bg-black/60 hover:bg-black text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}

            {error && (
              <div className="mt-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg border border-red-100">
                {error}
              </div>
            )}

            <div className="mt-6 pt-5 border-t border-gray-100 space-y-4">
              <div className="flex items-center justify-between text-sm bg-gray-50 border border-gray-200 rounded-lg p-3 w-full">
                <span className="text-gray-700 font-medium">目标账号区间：</span>
                <select 
                  value={batchOffset}
                  onChange={e => setBatchOffset(Number(e.target.value))}
                  className="bg-white border border-gray-300 rounded px-2 py-1 text-xs font-medium focus:ring-1 focus:ring-black outline-none cursor-pointer"
                >
                  <option value={0}>批次 1 (公众号 1-10)</option>
                  <option value={10}>批次 2 (公众号 11-20)</option>
                  <option value={20}>批次 3 (公众号 21-30)</option>
                  <option value={30}>批次 4 (公众号 31-40)</option>
                  <option value={40}>批次 5 (公众号 41-50)</option>
                </select>
              </div>

              <button
                onClick={handleGenerate}
                disabled={isGenerating || images.length === 0}
                className="w-full py-3 px-4 bg-black text-white rounded-xl font-medium shadow-sm hover:bg-gray-800 focus:ring-4 focus:ring-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    正在撰写文案...
                  </>
                ) : (
                  "生成图文文案"
                )}
              </button>
              <p className="text-xs text-center text-gray-400 mt-3 leading-relaxed">
                每张图片将独立生成 1 组专属的优质图文文案
              </p>
            </div>
          </div>
        </div>

        {/* Right Column - Output Area */}
        <div className="w-full lg:w-2/3 xl:w-3/4">
          {!results && !isGenerating && (
            <div className="h-full flex flex-col items-center justify-center min-h-[400px] text-gray-400 border-2 border-dashed border-gray-200 rounded-2xl bg-gray-50/50">
              <ImageIcon className="w-12 h-12 mb-4 text-gray-300" />
              <p className="text-sm">上传图片后，将在右侧生成优质文案</p>
            </div>
          )}

          {isGenerating && (
            <div className="h-full flex flex-col items-center justify-center min-h-[400px] text-gray-500 rounded-2xl bg-white shadow-sm border border-gray-100 p-8">
              <div className="w-full max-w-sm">
                <div className="flex justify-between items-end mb-3">
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-5 h-5 animate-spin text-black" />
                    <span className="text-[15px] font-medium text-gray-900">AI 正在深度思考并撰写文案...</span>
                  </div>
                  <span className="text-sm font-bold text-gray-900">{completedCount} / {images.length}</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2 mb-4 overflow-hidden border border-gray-200">
                  <motion.div 
                    className="bg-black h-full rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ ease: "easeInOut", duration: 0.3 }}
                  />
                </div>
                <p className="text-xs text-gray-400 text-center">拆分并行处理中，可极大提升生成速度及质量，请耐心等待</p>
              </div>
            </div>
          )}

          {results && (
            <div className="space-y-4">
              <div className="flex items-center justify-between px-2">
                <h2 className="text-lg font-semibold tracking-tight">为您生成了 {results.length} 组独立文案</h2>
                <p className="text-sm text-gray-500">每张图片自动匹配最优策略</p>
              </div>
              <div className="flex flex-col gap-5">
                {results.map((result, idx) => (
                  <ResultCard 
                    key={idx} 
                    data={result} 
                    index={idx + 1}
                    accountIndexOffset={batchOffset}
                    accounts={wechatAccounts}
                    onSync={(accountId) => syncToWechat(result, accountId)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}

function ResultCard({ data, index, accountIndexOffset, accounts, onSync }: { key?: React.Key, data: GeneratedContent, index: number, accountIndexOffset: number, accounts: WechatAccount[], onSync: (accountId: string) => void }) {
  const [copied, setCopied] = useState(false);
  const targetAccountIndex = accountIndexOffset + index - 1;
  const defaultAccount = accounts[targetAccountIndex] || accounts[0];
  const [selectedAccountId, setSelectedAccountId] = useState<string>(defaultAccount?.id || '');

  // Keep selectedAccountId updated if accounts change or index changes
  useEffect(() => {
    if (defaultAccount && !selectedAccountId) {
      setSelectedAccountId(defaultAccount.id);
    }
  }, [defaultAccount, selectedAccountId]);

  // Removed headers for pure text copy
  const rawText = 
`${data.title}

${data.content}

${data.ending}

${data.callToAction}

${data.tags}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(rawText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.1 }}
      className="bg-white rounded-xl overflow-hidden shadow-sm border border-gray-200 flex flex-col sm:flex-row items-stretch"
    >
      {data.imageUrl && (
        <div className="sm:w-48 xl:w-56 shrink-0 bg-gray-100 flex items-center justify-center p-4 border-b sm:border-b-0 sm:border-r border-gray-100">
          <img src={data.imageUrl} alt="Source" className="w-full h-auto object-cover rounded-lg shadow-sm" style={{ maxHeight: '200px' }} />
        </div>
      )}
      
      <div className="flex-1 flex flex-col h-full">
        <div className="px-5 py-3.5 bg-gray-50/50 flex items-center justify-between border-b border-gray-100">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center px-2 py-0.5 rounded bg-black text-white text-xs font-medium tracking-wide">
              图片 {index}
            </span>
            <span className="text-xs text-gray-500 font-medium px-2 py-0.5 bg-white border border-gray-200 rounded">{data.direction}</span>
          </div>
          <div className="flex items-center gap-3">
            <select 
              value={selectedAccountId} 
              onChange={e => setSelectedAccountId(e.target.value)}
              className="text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-black bg-white select-none max-w-[120px] truncate"
            >
              {accounts.map((acc, i) => (
                <option key={acc.id} value={acc.id}>{acc.name || `公众号 ${i+1}`}</option>
              ))}
            </select>
            <button
              onClick={() => onSync(selectedAccountId)}
              className="flex items-center gap-1.5 text-xs font-medium text-green-600 hover:text-green-700 transition-colors bg-green-50 px-2 py-1 rounded border border-green-100"
            >
              <Send className="w-3.5 h-3.5" /> 推送草稿
            </button>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-700 hover:text-black transition-colors bg-white border border-gray-200 shadow-sm px-2 py-1 rounded"
            >
              {copied ? (
                <><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> 已复制纯文本</>
              ) : (
                <><Copy className="w-3.5 h-3.5" /> 复制纯文本</>
              )}
            </button>
          </div>
        </div>
        
        <div className="p-5 space-y-4 text-sm flex-1">
          <div>
            <p className="text-base text-black font-semibold leading-tight">{data.title}</p>
          </div>

          <div>
            <p className="text-gray-700 leading-relaxed text-[15px]">{data.content}</p>
          </div>

          <div>
            <p className="text-gray-600 italic leading-relaxed text-[15px]">{data.ending}</p>
          </div>

          <div className="bg-orange-50/50 p-2.5 rounded-lg border border-orange-100">
            <p className="text-orange-800 text-[13px] font-medium flex items-center gap-1.5">
               <span className="w-1.5 h-1.5 rounded-full bg-orange-400 inline-block"></span>
               互动引导：{data.callToAction}
            </p>
          </div>

          <div className="pt-1">
            <p className="text-indigo-600 leading-relaxed font-mono text-[13px]">{data.tags}</p>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
