const sharp = require('sharp');
const path = require('path');

async function generateIcons() {
  // Create a shield icon SVG
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="96" fill="#0056A0"/>
    <path d="M256 80 L380 140 L380 260 C380 340 330 400 256 432 C182 400 132 340 132 260 L132 140 Z" 
          fill="none" stroke="white" stroke-width="20" stroke-linejoin="round"/>
    <path d="M220 260 L248 288 L296 220" fill="none" stroke="white" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  
  const buffer = Buffer.from(svg);
  
  await sharp(buffer).resize(192, 192).png().toFile(path.join(__dirname, 'public', 'icon-192.png'));
  await sharp(buffer).resize(512, 512).png().toFile(path.join(__dirname, 'public', 'icon-512.png'));
  
  console.log('Icons generated: icon-192.png, icon-512.png');
}

generateIcons().catch(console.error);
