import { Document, Packer, Paragraph, TextRun, HeadingLevel, CodeBlock } from "docx";
import { saveAs } from "file-saver";
import JSZip from "jszip";
import html2pdf from "html2pdf.js";
import type { Task, Subtask } from "../types";

// 1. Sanitize Task Name for Filenames
export const getSafeFilename = (description: string, extension: string) => {
  // Take first 40 chars, remove special chars, replace spaces with underscores
  const safeName = description
    .substring(0, 40)
    .replace(/[^a-z0-9]/gi, "_")
    .toLowerCase()
    .replace(/_+$/, ""); // remove trailing underscores
  return `${safeName}.${extension}`;
};

// 2. Check if Task Contains Code
export const hasCodeBlocks = (task: Task): boolean => {
  return task.subtasks.some((sub) => /```[\s\S]*?```/.test(sub.deliverable || ""));
};

// 3. Download Consolidated PDF
export const downloadTaskPDF = (task: Task) => {
  const element = document.getElementById("task-full-report");
  if (!element) return;

  const filename = getSafeFilename(task.description, "pdf");
  
  const opt = {
    margin: 0.5,
    filename,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2, backgroundColor: "#ffffff" }, // Force white background for PDF
    jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
  };

  // Temporarily force light theme for the export if your app is dark mode
  const originalBg = element.style.backgroundColor;
  const originalColor = element.style.color;
  element.style.backgroundColor = "#ffffff";
  element.style.color = "#000000";

  html2pdf().set(opt).from(element).save().then(() => {
    // Restore original styles
    element.style.backgroundColor = originalBg;
    element.style.color = originalColor;
  });
};

// 4. Download Consolidated DOCX (Word)
export const downloadTaskDOCX = async (task: Task) => {
  const filename = getSafeFilename(task.description, "docx");

  const children: Paragraph[] = [
    new Paragraph({
      text: task.description,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 },
    }),
    new Paragraph({
      text: `Total Budget: $${(task.totalBudget / 1_000_000).toFixed(2)} USDC`,
      spacing: { after: 400 },
    }),
  ];

  task.subtasks.forEach((sub: Subtask, index: number) => {
    if (!sub.deliverable) return;

    // Subtask Heading
    children.push(
      new Paragraph({
        text: `Subtask ${index + 1}: ${sub.description}`,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 100 },
      })
    );

    // Simple text parsing for DOCX (strips markdown symbols for clean Word doc)
    const cleanText = sub.deliverable
      .replace(/```[\s\S]*?```/g, "[Code Block - See PDF or Code Download]")
      .replace(/#{1,6}\s/g, "")
      .replace(/\*\*/g, "")
      .replace(/\*/g, "");

    children.push(
      new Paragraph({
        children: [new TextRun(cleanText)],
        spacing: { after: 200 },
      })
    );
  });

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  saveAs(blob, filename);
};

// 5. Smart Code Download (ZIP if multiple, single file if one)
export const downloadTaskCode = (task: Task) => {
  const codeBlocks: { lang: string; code: string; subtaskIndex: number }[] = [];

  task.subtasks.forEach((sub, index) => {
    if (!sub.deliverable) return;
    const matches = sub.deliverable.matchAll(/```(\w+)?\n([\s\S]*?)```/g);
    for (const match of matches) {
      codeBlocks.push({
        lang: match[1] || "txt",
        code: match[2],
        subtaskIndex: index,
      });
    }
  });

  if (codeBlocks.length === 0) {
    alert("No code blocks found in this task!");
    return;
  }

  const filenameBase = getSafeFilename(task.description, "").replace(".", "");

  if (codeBlocks.length === 1) {
    // Single file download
    const ext = codeBlocks[0].lang === "javascript" ? "js" : codeBlocks[0].lang;
    const blob = new Blob([codeBlocks[0].code], { type: "text/plain" });
    saveAs(blob, `${filenameBase}.${ext}`);
  } else {
    // Multiple files: Create a ZIP
    const zip = new JSZip();
    codeBlocks.forEach((block, i) => {
      const ext = block.lang === "javascript" ? "js" : block.lang;
      zip.file(`subtask_${block.subtaskIndex + 1}_code.${ext}`, block.code);
    });
    
    zip.generateAsync({ type: "blob" }).then((blob) => {
      saveAs(blob, `${filenameBase}_code_files.zip`);
    });
  }
};