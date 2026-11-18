export const GUIDE_HTML = `
<h1 class="display">Setup guide</h1>
<p class="lead">Three pictures of one canvas, one print file. Here's how to get each picture right.</p>

<h2>1. Prepare the blank</h2>
<ul>
  <li><b>Tape it to dark card.</b> Tape the canvas to matte card in black or another dark, bold color (navy, red, green, purple) at its four corners, on the outer margin. White or pale card won't work: the holes need something dark behind them. A black scanner lid works without card.</li>
  <li><b>Add one dot on the tape.</b> Make one solid dot with a permanent marker or a small round sticker, about pea-sized (⅛ to ⅜ in), darker than the tape. Never mark the canvas itself. Tape usually sits half on the canvas and half on the card: put the dot on the half that's on top of the canvas, near a corner, outside where the design, key or logo will go, and within about ½ in of intersections you can see. A dot on the half over the card is too far away to count from. Use only one dot, and keep any writing away from it.</li>
</ul>
<p>The dot is how the two pictures are matched up: it shows which way round the canvas is, and the site counts out from the intersections nearest it, so the closer it sits to visible intersections, the better.</p>

<h2>2. Scan it</h2>
<ul>
  <li>Lay the card on the glass with the canvas face down. Any direction is fine.</li>
  <li>If the canvas is longer than the glass, center it so each end hangs off equally, ¼ in or less.</li>
</ul>
<table>
  <tr><th>Setting</th><th>Use</th></tr>
  <tr><td>Resolution</td><td>600 dpi (300 minimum), the scanner's true optical resolution</td></tr>
  <tr><td>Color</td><td>Color, 24-bit</td></tr>
  <tr><td>File type</td><td>PNG or TIFF if you can, otherwise JPEG at highest quality</td></tr>
  <tr><td>Sharpening, descreening, auto color, auto exposure, dust removal</td><td>All off</td></tr>
  <tr><td>Scan area</td><td>The whole glass, so no intersections are cropped off</td></tr>
</table>
<p>Upload the scan on a new job: its tile shows the mesh and canvas size it measured, and whether it found your dot.</p>

<h2>3. Tape it to the xTool M2 tray</h2>
<ul>
  <li>Use the exact canvas you scanned. Two blanks of the same size can't be told apart.</li>
  <li>The tray is already black, so no card is needed. If the canvas is taped to card, you can move them together.</li>
  <li>Tape all four sides at the margin. Keep the design out of the top-left corner of the bed as xTool Studio shows it: the print head can't reach a patch about 3.3 × 4.3 in there.</li>
</ul>

<h2>4. Take the xTool screenshot</h2>
<ul>
  <li>Close the lid. In xTool Studio's camera tools, use <b>Close-up Stitching</b> and select the whole canvas with a little room on every side. Wait for it to finish.</li>
  <li>Make xTool Studio full screen, hide side panels, and zoom until the canvas fills the view.</li>
  <li>Screenshot just the preview: the canvas and a little tray, no toolbars. Don't shrink the screenshot afterwards.</li>
  <li>Leave the lid shut and don't take another preview until the print file is placed.</li>
</ul>
<p>If the screenshot's tile says it came out small, zoom in further next time.</p>

<h2>5. Your chart</h2>
<ul>
  <li><b>Stitchly</b> (.stitchly) or <b>OXS</b> (.oxs) chart files come in as they are, with their stitch count and DMC thread colours. If a thread's colour isn't known, the Chart tile lets you pick it once and remembers it.</li>
  <li><b>MacStitch</b>: its own .chart files are locked, so export the chart as OXS from MacStitch and add that.</li>
  <li><b>StitchALot</b>: export the chart as a PNG for now.</li>
  <li><b>A picture of the chart</b> (PNG, JPEG, TIFF, or a PDF page): one flat colour per stitch, no gridlines, symbols, border or smoothing, bare canvas transparent. One pixel per stitch is best; any whole number of pixels per stitch works (a chart 104 stitches across can be 104, 208 or 1040 px wide). A PDF can be any size.</li>
</ul>

<h2>6. Place it in xTool Studio and print</h2>
<ol>
  <li>Import the SVG without resizing it. It's real size, with a magenta frame.</li>
  <li>Drag the magenta frame onto the stitched preview. Zoom right in on a corner and line it up exactly. Never rotate or scale it.</li>
  <li>Check with a Close shot or two, aimed at the spot you're checking. Turn color layers off and on to check each one. Small arrow-key nudges are fine.</li>
  <li>Delete the magenta frame, then print.</li>
</ol>
<p>First time? Try it on scrap canvas with a small, simple chart.</p>
`;

export const TROUBLE_HTML = `
<h2 id="off">When a print comes out off</h2>
<p>Work down this list in order.</p>
<ol>
  <li><b>Try a light nudge.</b> In xTool Studio, move the whole group a touch with the arrow keys. Never rotate or resize it. If an end still won't sit on its intersections after a couple of nudges, stop and go on.</li>
  <li><b>Did the canvas or camera move?</b> If the canvas was bumped, the lid was opened, or you took a new preview after your screenshot, the frame has nothing to match. Take a new Close-up Stitching preview and screenshot, and run the same job again with it. Your scan is still good unless the canvas got stretched.</li>
  <li><b>Is it the same canvas?</b> One scan belongs to one blank. Two blanks of the same size and mesh look alike, so a scan of one and a screenshot of another can pass every check and still print off.</li>
  <li><b>Check your M2's own calibration.</b> Run xTool's print head and camera calibration again if it's been a while or anything changed.</li>
</ol>

<h2>Questions</h2>
<h3>Which printers does it work with?</h3>
<p>The xTool M2 only, for now. Any flatbed scanner with a true 600 dpi works.</p>
<h3>Why can't I use a white scanner lid?</h3>
<p>The site reads the canvas threads against the dark behind them. White thread on a white lid barely shows. Use black or any dark, bold card.</p>
<h3>Can one scan be used for two blanks the same size?</h3>
<p>No. Every blank's intersections sit a little differently, so scan each one.</p>
<h3>My chart came out the wrong way round.</h3>
<p>On Review, open Adjust and press Turn left, Turn right or Upside down, from how it looks in the preview. Never turn the file in xTool Studio. If designs keep turning when you don't want them to, choose As drawn in Preferences.</p>
<h3>Can I resize or rotate the file in xTool Studio to make it fit?</h3>
<p>No. It's sized in real millimeters and every stitch sits on an intersection, so any resize or turn throws the stitches off. Light nudges of the whole group are fine.</p>
<h3>The canvas moved after I took the screenshot. Is my scan ruined?</h3>
<p>No. Take a new screenshot, add it to the same job, and run it again.</p>
<h3>A check shows a yellow or red row.</h3>
<p>Red stops the job, and the row says what it found. Yellow means look twice: check the preview and both end zooms before you print.</p>
`;
