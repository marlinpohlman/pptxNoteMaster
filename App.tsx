
import React, { useState, useCallback, useMemo } from 'react';
import { GoogleGenAI } from '@google/genai';
import { SlideData, ProcessingState } from './types';
import { UploadIcon, FilePptIcon, FilePdfIcon, AlertIcon } from './components/icons';

// Declare external libraries from index.html
declare const pdfjsLib: any;
declare const JSZip: any;
declare const PptxGenJS: any;

const App: React.FC = () => {
    const [file, setFile] = useState<File | null>(null);
    const [slidesData, setSlidesData] = useState<SlideData[]>([]);
    const [status, setStatus] = useState<ProcessingState>(ProcessingState.IDLE);
    const [progress, setProgress] = useState({ current: 0, total: 0 });
    const [error, setError] = useState<string | null>(null);
    const [selectedSlide, setSelectedSlide] = useState(0);

    const isProcessing = useMemo(() => {
        return [
            ProcessingState.PARSING,
            ProcessingState.GENERATING_NOTES,
            ProcessingState.CREATING_PPT,
        ].includes(status);
    }, [status]);

    const resetState = () => {
        setFile(null);
        setSlidesData([]);
        setStatus(ProcessingState.IDLE);
        setProgress({ current: 0, total: 0 });
        setError(null);
        setSelectedSlide(0);
    };

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = event.target.files?.[0];
        if (selectedFile) {
            if (selectedFile.type === 'application/pdf' || selectedFile.name.endsWith('.pptx')) {
                setFile(selectedFile);
                setError(null);
                processFile(selectedFile);
            } else {
                setError('Invalid file type. Please upload a PDF or PPTX file.');
            }
        }
    };
    
    const parsePptx = async (file: File): Promise<Omit<SlideData, 'speakerNotes' | 'sources'>[]> => {
        const zip = await JSZip.loadAsync(file);
        const slidePromises = [];
        let i = 1;
        while (zip.file(`ppt/slides/slide${i}.xml`)) {
            const slideFile = zip.file(`ppt/slides/slide${i}.xml`);
            if (slideFile) {
                slidePromises.push(slideFile.async('string'));
            }
            i++;
        }
        
        const slideXmls = await Promise.all(slidePromises);
        return slideXmls.map((xml, index) => {
            const textNodes = xml.match(/<a:t>.*?<\/a:t>/g) || [];
            const originalText = textNodes.map(node => node.replace(/<a:t>(.*?)<\/a:t>/, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join(' ');
            return {
                slideNumber: index + 1,
                imageDataUrl: null, // No image preview for PPTX to keep it client-side
                originalText,
            };
        });
    };

    const parsePdf = async (file: File): Promise<Omit<SlideData, 'speakerNotes' | 'sources'>[]> => {
        const fileReader = new FileReader();
        return new Promise((resolve, reject) => {
            fileReader.onload = async (e) => {
                try {
                    const typedarray = new Uint8Array(e.target?.result as ArrayBuffer);
                    const pdf = await pdfjsLib.getDocument(typedarray).promise;
                    const slides: Omit<SlideData, 'speakerNotes' | 'sources'>[] = [];
                    
                    for (let i = 1; i <= pdf.numPages; i++) {
                        setProgress({current: i, total: pdf.numPages});
                        const page = await pdf.getPage(i);

                        // Optimize image rendering to prevent memory issues
                        const targetWidth = 1280; // Standard width for a 16:9 slide
                        const viewport = page.getViewport({ scale: 1.0 });
                        const scale = targetWidth / viewport.width;
                        const scaledViewport = page.getViewport({ scale });

                        const canvas = document.createElement('canvas');
                        const context = canvas.getContext('2d');
                        canvas.height = scaledViewport.height;
                        canvas.width = scaledViewport.width;

                        if (context) {
                            await page.render({ canvasContext: context, viewport: scaledViewport }).promise;
                        }
                        
                        const textContent = await page.getTextContent();
                        const originalText = textContent.items.map((item: any) => item.str).join(' ');

                        slides.push({
                            slideNumber: i,
                            imageDataUrl: canvas.toDataURL('image/jpeg', 0.8), // Use compressed JPEG
                            originalText,
                        });
                    }
                    resolve(slides);
                } catch (err) {
                    reject(err);
                }
            };
            fileReader.onerror = reject;
            fileReader.readAsArrayBuffer(file);
        });
    };
    
    const generateNotesForSlide = async (
        slideText: string, 
        slideNumber: number, 
        allSlides: Omit<SlideData, 'speakerNotes' | 'sources'>[]
    ): Promise<{ notes: string; sources: { uri: string; title: string }[] }> => {
        if (!process.env.API_KEY) {
            throw new Error("API_KEY environment variable not set.");
        }
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

        const previousSlideText = slideNumber > 1 ? allSlides[slideNumber - 2]?.originalText : '';
        const nextSlideText = slideNumber < allSlides.length ? allSlides[slideNumber]?.originalText : '';
        
        let context_section = '';
        if (previousSlideText || nextSlideText) {
            context_section += "\n\nCONTEXT FROM ADJACENT SLIDES:\n";
            if (previousSlideText) {
                context_section += `\nContent from previous slide (Slide ${slideNumber - 1}):\n---\n${previousSlideText}\n---\n`;
            }
            if (nextSlideText) {
                context_section += `\nContent from next slide (Slide ${slideNumber + 1}):\n---\n${nextSlideText}\n---\n`;
            }
        }

        const timing_section = '';
        const biography_instruction = '';

        const prompt = `You are an expert instructional designer and presentation coach specializing in adult education. Create comprehensive educational materials that combine traditional speaker notes with advanced adult learning principles.

SLIDE ${slideNumber} CONTENT:
${slideText}
${context_section}${timing_section}${biography_instruction}

CORE REQUIREMENTS:

1. COMPREHENSIVE SPEAKER NOTES: Create detailed, precise explanations that help students understand concepts thoroughly. Include:
   - Clear, step-by-step breakdowns of complex ideas
   - Multiple perspectives on the same concept
   - Natural talking points that flow smoothly with the material
   - Connections to prior knowledge and real-world applications
   - Anticipation of common student questions and misconceptions
   - Relevant facts, examples, or explanations that enhance understanding
   - If this slide contains an exercise or activity, provide a complete step-by-step walkthrough with answers

2. ADULT LEARNING PRINCIPLES: Incorporate these principles throughout your notes:
   - SELF-DIRECTED LEARNING: Encourage learners to take ownership and explore further
   - EXPERIENTIAL LEARNING: Connect to learners' existing experiences and knowledge
   - READINESS TO LEARN: Explain why this knowledge is immediately relevant
   - PROBLEM-CENTERED APPROACH: Frame content around solving real problems
   - INTERNAL MOTIVATION: Appeal to intrinsic motivators like mastery and purpose
   - NEED TO KNOW: Clearly establish why learners need this information
   - RESPECT FOR EXPERIENCE: Acknowledge and build upon adult learners' life experiences

3. INDUSTRIAL EXAMPLES: Provide 1-2 fictional but realistic industrial scenarios that demonstrate the concepts in action. Examples should:
   - Be specific and detailed (company names, situations, outcomes)
   - Show both successful applications and potential pitfalls
   - Connect directly to the slide content
   - Be relatable across different industries when possible

4. VISUAL ENHANCEMENTS: If Mermaid.js diagrams would enhance understanding, include them in [MERMAID] tags:
   - Simplify complex processes or relationships
   - Show data flows, organizational structures, or timelines
   - Illustrate cause-and-effect relationships
   - Provide visual memory anchors for key concepts

CRITICAL RESTRICTIONS:
- DO NOT include any greetings, salutations, or welcome messages
- DO NOT reference "Good Morning", "Good Afternoon", or any time-based greetings
- DO NOT include any copyright notices or company references
- DO NOT mention the presenting company or copyright holders
- DO NOT explicitly reference previous or following slides
- Assume this slide builds on established foundation without stating so

INSTRUCTIONAL DESIGN GUIDELINES:
- Use conversational, engaging tone that respects adult learners' intelligence
- Include rhetorical questions to promote reflection
- Suggest interactive elements or discussion points
- Provide clear takeaways and action items
- Connect to broader learning objectives and career applications
- Include timing guidance to maintain pace (e.g., "Spend 2 minutes on this concept")
- Focus on the educational content without meta-commentary about the presentation structure
- For any abbreviations or acronyms provide a lexicon with basic background information
- When possible, attempt to provide first person smooth conversation delivery of content
- Attempt not to repeat content delivered in prior slides in the same context or delivery style
- Search the web for additional data if the slide lacks detail

RESPONSE FORMAT:
Format the response as comprehensive educational content that an instructor can follow while presenting. Structure your response as natural speaker notes that flow smoothly and incorporate all the above principles seamlessly.

Now create comprehensive speaker notes for this slide.`;

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    tools: [{googleSearch: {}}],
                },
            });
            const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
            const sources = chunks
                .map((chunk: any) => chunk.web)
                .filter((web: any) => web && web.uri && web.title);

            return {
                notes: response.text,
                sources: sources
            };

        } catch (error) {
            console.error("Error generating notes:", error);
            return {
                notes: "Could not generate notes for this slide.",
                sources: []
            };
        }
    };

    const processFile = useCallback(async (fileToProcess: File) => {
        try {
            resetState();
            setFile(fileToProcess);
            setStatus(ProcessingState.PARSING);

            const parsedSlides = fileToProcess.name.endsWith('.pptx') 
                ? await parsePptx(fileToProcess)
                : await parsePdf(fileToProcess);
            
            setStatus(ProcessingState.GENERATING_NOTES);
            const slidesWithNotes: SlideData[] = [];
            for (let i = 0; i < parsedSlides.length; i++) {
                setProgress({ current: i + 1, total: parsedSlides.length });
                const slide = parsedSlides[i];
                const { notes, sources } = await generateNotesForSlide(slide.originalText, slide.slideNumber, parsedSlides);
                slidesWithNotes.push({ ...slide, speakerNotes: notes, sources });
            }

            setSlidesData(slidesWithNotes);
            setStatus(ProcessingState.DONE);

        } catch (e: any) {
            console.error(e);
            setError(`An error occurred: ${e.message}`);
            setStatus(ProcessingState.ERROR);
        }
    }, []);

    const handleNoteChange = (index: number, newText: string) => {
        setSlidesData(prev => prev.map((slide, i) => i === index ? { ...slide, speakerNotes: newText } : slide));
    };

    const handleDownload = async () => {
        if (slidesData.length === 0) {
            setError("There are no slides to download.");
            return;
        }
        setStatus(ProcessingState.CREATING_PPT);
        setProgress({ current: 0, total: slidesData.length });

        try {
            const pptx = new PptxGenJS();
            pptx.layout = 'LAYOUT_WIDE';

            for (let i = 0; i < slidesData.length; i++) {
                const slideData = slidesData[i];
                const slide = pptx.addSlide();
                
                if (slideData.imageDataUrl) {
                    // PDF-based slide with image
                    slide.background = { path: slideData.imageDataUrl };
                } else {
                    // PPTX-based slide with text only
                    slide.addText(`Slide ${slideData.slideNumber}`, { x: 0.5, y: 0.25, fontSize: 18, bold: true, color: '363636' });
                    slide.addText(slideData.originalText, { x: 0.5, y: 1.0, w: '90%', h: '80%', fontSize: 12, color: '363636', align: 'left' });
                }

                slide.addNotes(slideData.speakerNotes);
                setProgress({ current: i + 1, total: slidesData.length });
            }
            
            const getOutputFilename = () => {
                if (!file) return 'presentation_with_notes.pptx';
                const baseName = file.name.replace(/\.(pptx|pdf)$/i, '');
                return `${baseName}_with_notes.pptx`;
            };

            // Use the library's built-in file writer. It is more robust and memory-efficient
            // for large presentations than manually creating a blob.
            await pptx.writeFile({ fileName: getOutputFilename() });

            setStatus(ProcessingState.DONE);
        } catch (e: any) {
            console.error("Error creating PPTX:", e);
            setError(`An error occurred while creating the presentation: ${e.message}`);
            setStatus(ProcessingState.ERROR);
        }
    };

    const currentSlide = slidesData[selectedSlide];

    return (
        <div className="min-h-screen bg-base-100 flex flex-col items-center p-4 sm:p-8 text-content-100 font-sans">
            <header className="w-full max-w-5xl text-center mb-8">
                <h1 className="text-4xl sm:text-5xl font-bold text-white">AI Presentation Notes Generator</h1>
                <p className="text-lg text-content-200 mt-2">Upload your presentation, and let AI create your speaker notes instantly.</p>
            </header>

            <main className="w-full max-w-5xl flex-grow flex flex-col items-center justify-center bg-base-200 rounded-xl shadow-2xl p-4 sm:p-8">
                {status === ProcessingState.IDLE && (
                    <div className="w-full text-center">
                        <label htmlFor="file-upload" className="cursor-pointer group">
                            <div className="border-4 border-dashed border-base-300 group-hover:border-brand-secondary transition-colors rounded-lg p-10 sm:p-20 flex flex-col items-center">
                                <UploadIcon className="w-16 h-16 text-content-200 group-hover:text-brand-secondary transition-colors" />
                                <p className="mt-4 text-xl font-semibold">Drag & drop your file here</p>
                                <p className="text-content-200">or click to browse</p>
                                <p className="mt-2 text-sm text-content-200">( .pdf or .pptx )</p>
                            </div>
                        </label>
                        <input id="file-upload" type="file" className="hidden" onChange={handleFileChange} accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" />
                    </div>
                )}
                
                {isProcessing && (
                    <div className="flex flex-col items-center text-center">
                         <div className="w-16 h-16 border-4 border-brand-secondary border-t-transparent rounded-full animate-spin"></div>
                         <h2 className="text-2xl font-semibold mt-6 text-white">
                            {status === ProcessingState.PARSING && `Parsing ${file?.name}...`}
                            {status === ProcessingState.GENERATING_NOTES && `Generating Notes...`}
                            {status === ProcessingState.CREATING_PPT && `Creating Presentation...`}
                         </h2>
                         <p className="text-content-200 mt-2">Please wait, this may take a few moments.</p>
                         {progress.total > 0 && (
                            <div className="w-64 mt-4 bg-base-300 rounded-full h-2.5">
                                <div className="bg-brand-secondary h-2.5 rounded-full" style={{ width: `${(progress.current / progress.total) * 100}%` }}></div>
                            </div>
                         )}
                         <p className="text-sm mt-2 text-content-200">{progress.current} / {progress.total}</p>
                    </div>
                )}

                {status === ProcessingState.DONE && slidesData.length > 0 && (
                    <div className="w-full flex flex-col lg:flex-row gap-8 h-[70vh]">
                        {/* Left Panel: Slide Thumbnails */}
                        <div className="w-full lg:w-1/4 flex-shrink-0">
                            <h3 className="text-lg font-bold mb-4 text-white">Slides</h3>
                            <div className="bg-base-300 p-2 rounded-lg h-[calc(70vh-80px)] overflow-y-auto">
                                {slidesData.map((slide, index) => (
                                    <div key={index} onClick={() => setSelectedSlide(index)} className={`cursor-pointer rounded-md p-2 mb-2 transition-all ${selectedSlide === index ? 'bg-brand-primary' : 'hover:bg-base-100'}`}>
                                        <div className="flex items-center gap-4">
                                            {slide.imageDataUrl ? (
                                                <img src={slide.imageDataUrl} alt={`Slide ${slide.slideNumber}`} className="w-20 h-auto object-contain rounded" />
                                            ) : (
                                                <div className="w-20 h-12 bg-base-100 rounded flex items-center justify-center">
                                                  <FilePptIcon className="w-8 h-8 text-content-200"/>
                                                </div>
                                            )}
                                            <span className={`font-semibold ${selectedSlide === index ? 'text-white' : ''}`}>Slide {slide.slideNumber}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Right Panel: Selected Slide and Notes */}
                        <div className="w-full lg:w-3/4 flex flex-col">
                           <h3 className="text-lg font-bold mb-4 text-white">Slide Preview & Speaker Notes</h3>
                            <div className="flex-grow flex flex-col lg:flex-row gap-4 bg-base-300 p-4 rounded-lg h-[calc(70vh-80px)] overflow-y-auto">
                                <div className="w-full lg:w-1/2 flex items-center justify-center p-2 bg-black rounded">
                                    {currentSlide.imageDataUrl ? (
                                        <img src={currentSlide.imageDataUrl} alt={`Slide ${currentSlide.slideNumber}`} className="max-w-full max-h-full object-contain" />
                                    ) : (
                                        <div className="p-4 text-sm text-content-200 overflow-auto">
                                          <h4 className="font-bold mb-2">Extracted Text (No Image Preview for .pptx)</h4>
                                          <p>{currentSlide.originalText}</p>
                                        </div>
                                    )}
                                </div>
                                <div className="w-full lg:w-1/2 flex flex-col">
                                    <h4 className="font-bold text-white">Speaker Notes</h4>
                                    <textarea
                                        value={currentSlide.speakerNotes}
                                        onChange={(e) => handleNoteChange(selectedSlide, e.target.value)}
                                        className="w-full flex-grow bg-base-100 text-content-100 p-3 rounded-md mt-2 focus:ring-2 focus:ring-brand-secondary focus:outline-none"
                                        placeholder="AI generated notes will appear here..."
                                    />
                                    {currentSlide.sources && currentSlide.sources.length > 0 && (
                                        <div className="mt-4 flex-shrink-0">
                                            <h5 className="font-bold text-white text-sm">Sources from Web Search:</h5>
                                            <ul className="list-disc list-inside text-sm text-content-200 mt-1 space-y-1">
                                                {currentSlide.sources.map((source, index) => (
                                                    <li key={index}>
                                                        <a href={source.uri} target="_blank" rel="noopener noreferrer" className="text-brand-secondary hover:underline">
                                                            {source.title}
                                                        </a>
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="lg:absolute lg:top-8 lg:right-8 flex flex-col sm:flex-row gap-4 mt-4 lg:mt-0">
                           <button onClick={resetState} className="py-2 px-6 bg-base-300 hover:bg-opacity-80 rounded-lg font-semibold transition-colors">Start Over</button>
                           <button onClick={handleDownload} className="py-2 px-6 bg-brand-secondary hover:bg-brand-primary text-white rounded-lg font-semibold transition-colors">Download PPTX</button>
                        </div>
                    </div>
                )}
                
                {(status === ProcessingState.IDLE || status === ProcessingState.ERROR) && error && (
                    <div className="mt-4 w-full max-w-md bg-red-900 border border-red-700 text-red-100 px-4 py-3 rounded-lg relative flex items-center gap-3">
                       <AlertIcon className="w-6 h-6"/>
                       <span className="block sm:inline">{error}</span>
                    </div>
                )}

                {status === ProcessingState.ERROR && (
                    <button onClick={resetState} className="mt-6 py-2 px-6 bg-brand-secondary hover:bg-brand-primary text-white rounded-lg font-semibold transition-colors">Try Again</button>
                )}

            </main>
        </div>
    );
};

export default App;
