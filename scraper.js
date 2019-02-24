// Parses the development applications at the South Australian Clare and Gilbert Valleys Council
// web site and places them in a database.
//
// Michael Bone
// 28th January 2019
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const cheerio = require("cheerio");
const request = require("request-promise-native");
const sqlite3 = require("sqlite3");
const urlparser = require("url");
const moment = require("moment");
const pdfjs = require("pdfjs-dist");
const didyoumean2_1 = require("didyoumean2"), didyoumean = didyoumean2_1;
sqlite3.verbose();
const DevelopmentApplicationsUrl = "https://www.claregilbertvalleys.sa.gov.au/page.aspx?u=491";
const CommentUrl = "mailto:admin@cgvc.sa.gov.au";
// Address information.
let StreetNames = null;
let StreetSuffixes = null;
let SuburbNames = null;
// Sets up an sqlite database.
async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [legal_description] text)");
            resolve(database);
        });
    });
}
// Inserts a row in the database if the row does not already exist.
async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate,
            developmentApplication.legalDescription
        ], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\", legal description \"${developmentApplication.legalDescription}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\", legal description \"${developmentApplication.legalDescription}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// Reads all the address information into global objects.
function readAddressInformation() {
    // Read the street names.
    StreetNames = {};
    for (let line of fs.readFileSync("streetnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetNameTokens = line.toUpperCase().split(",");
        let streetName = streetNameTokens[0].trim();
        let suburbName = streetNameTokens[1].trim();
        (StreetNames[streetName] || (StreetNames[streetName] = [])).push(suburbName); // several suburbs may exist for the same street name
    }
    // Read the street suffixes.
    StreetSuffixes = {};
    for (let line of fs.readFileSync("streetsuffixes.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetSuffixTokens = line.toUpperCase().split(",");
        StreetSuffixes[streetSuffixTokens[0].trim()] = streetSuffixTokens[1].trim();
    }
    // Read the suburb names.
    SuburbNames = {};
    for (let line of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let suburbTokens = line.toUpperCase().split(",");
        let suburbName = suburbTokens[0].trim();
        SuburbNames[suburbName] = suburbTokens[1].trim();
        if (suburbName.startsWith("MOUNT ")) {
            SuburbNames["MT " + suburbName.substring("MOUNT ".length)] = suburbTokens[1].trim();
            SuburbNames["MT." + suburbName.substring("MOUNT ".length)] = suburbTokens[1].trim();
            SuburbNames["MT. " + suburbName.substring("MOUNT ".length)] = suburbTokens[1].trim();
        }
    }
}
// Constructs a rectangle based on the intersection of the two specified rectangles.
function intersect(rectangle1, rectangle2) {
    let x1 = Math.max(rectangle1.x, rectangle2.x);
    let y1 = Math.max(rectangle1.y, rectangle2.y);
    let x2 = Math.min(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y2 = Math.min(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    if (x2 >= x1 && y2 >= y1)
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    else
        return { x: 0, y: 0, width: 0, height: 0 };
}
// Calculates the fraction of an element that lies within a cell (as a percentage).  For example,
// if a quarter of the specifed element lies within the specified cell then this would return 25.
function getPercentageOfElementInCell(element, cell) {
    let elementArea = getArea(element);
    let intersectionArea = getArea(intersect(cell, element));
    return (elementArea === 0) ? 0 : ((intersectionArea * 100) / elementArea);
}
// Calculates the area of a rectangle.
function getArea(rectangle) {
    return rectangle.width * rectangle.height;
}
// Gets the percentage of horizontal overlap between two rectangles (0 means no overlap and 100
// means 100% overlap).
function getHorizontalOverlapPercentage(rectangle1, rectangle2) {
    if (rectangle1 === undefined || rectangle2 === undefined)
        return 0;
    let startX1 = rectangle1.x;
    let endX1 = rectangle1.x + rectangle1.width;
    let startX2 = rectangle2.x;
    let endX2 = rectangle2.x + rectangle2.width;
    if (startX1 >= endX2 || endX1 <= startX2 || rectangle1.width === 0 || rectangle2.width === 0)
        return 0;
    let intersectionWidth = Math.min(endX1, endX2) - Math.max(startX1, startX2);
    let unionWidth = Math.max(endX1, endX2) - Math.min(startX1, startX2);
    return (intersectionWidth * 100) / unionWidth;
}
// Formats the text as a street.
function formatStreetName(text) {
    if (text === undefined)
        return text;
    let tokens = text.trim().toUpperCase().split(" ");
    // Expand the street suffix (for example, this converts "ST" to "STREET").
    let token = tokens.pop();
    let streetSuffix = StreetSuffixes[token];
    tokens.push((streetSuffix === undefined) ? token : streetSuffix);
    // Extract tokens from the end of the array until a valid street name is encountered (this
    // looks for an exact match).  Note that "PRINCESS MARGARET ROSE CAVES ROAD" is the street
    // name with the most words (ie. five).  But there may be more words in the street name due
    // to errant spaces.
    for (let index = 6; index >= 2; index--)
        if (StreetNames[tokens.slice(-index).join(" ")] !== undefined)
            return tokens.join(" "); // reconstruct the street with the leading house number (and any other prefix text)
    // Extract tokens from the end of the array until a valid street name is encountered (this
    // allows for a spelling error).
    for (let index = 6; index >= 2; index--) {
        let threshold = 7 - index; // set the number of allowed spelling errors proportional to the number of words
        let streetNameMatch = didyoumean2_1.default(tokens.slice(-index).join(" "), Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: threshold, trimSpaces: true });
        if (streetNameMatch !== null) {
            tokens.splice(-index, index); // remove elements from the end of the array           
            return (tokens.join(" ") + " " + streetNameMatch).trim(); // reconstruct the street with any other original prefix text
        }
    }
    return text;
}
// Formats the address, ensuring that it has a valid suburb, state and post code.
function formatAddress(address) {
    // Allow for a few special cases (eg. road type suffixes).
    address = address.replace(/ TCE NTH/g, " TERRACE NORTH").replace(/ TCE STH/g, " TERRACE SOUTH").replace(/ TCE EAST/g, " TERRACE EAST").replace(/ TCE WEST/g, " TERRACE WEST");
    // Break the address up based on commas (the main components of the address are almost always
    // separated by commas).
    let commaIndex = address.lastIndexOf(",");
    if (commaIndex < 0)
        return address;
    let streetName = address.substring(0, commaIndex);
    let suburbName = address.substring(commaIndex + 1);
    // Add the state and post code to the suburb name.
    suburbName = didyoumean2_1.default(suburbName, Object.keys(SuburbNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true });
    if (suburbName === null)
        return address;
    // Reconstruct the full address using the formatted street name and determined suburb name.
    return formatStreetName(streetName) + ", " + SuburbNames[suburbName];
}
// Examines all the lines in a page of a PDF and constructs cells (ie. rectangles) based on those
// lines.
async function parseCells(page) {
    let operators = await page.getOperatorList();
    // Find the lines.  Each line is actually constructed using a rectangle with a very short
    // height or a very narrow width.
    let lines = [];
    let previousRectangle = undefined;
    let transformStack = [];
    let transform = [1, 0, 0, 1, 0, 0];
    transformStack.push(transform);
    for (let index = 0; index < operators.fnArray.length; index++) {
        let argsArray = operators.argsArray[index];
        if (operators.fnArray[index] === pdfjs.OPS.restore)
            transform = transformStack.pop();
        else if (operators.fnArray[index] === pdfjs.OPS.save)
            transformStack.push(transform);
        else if (operators.fnArray[index] === pdfjs.OPS.transform)
            transform = pdfjs.Util.transform(transform, argsArray);
        else if (operators.fnArray[index] === pdfjs.OPS.constructPath) {
            let argumentIndex = 0;
            for (let operationIndex = 0; operationIndex < argsArray[0].length; operationIndex++) {
                if (argsArray[0][operationIndex] === pdfjs.OPS.moveTo)
                    argumentIndex += 2;
                else if (argsArray[0][operationIndex] === pdfjs.OPS.lineTo)
                    argumentIndex += 2;
                else if (argsArray[0][operationIndex] === pdfjs.OPS.rectangle) {
                    let x1 = argsArray[1][argumentIndex++];
                    let y1 = argsArray[1][argumentIndex++];
                    let width = argsArray[1][argumentIndex++];
                    let height = argsArray[1][argumentIndex++];
                    let x2 = x1 + width;
                    let y2 = y1 + height;
                    [x1, y1] = pdfjs.Util.applyTransform([x1, y1], transform);
                    [x2, y2] = pdfjs.Util.applyTransform([x2, y2], transform);
                    width = x2 - x1;
                    height = y2 - y1;
                    previousRectangle = { x: x1, y: y1, width: width, height: height };
                }
            }
        }
        else if ((operators.fnArray[index] === pdfjs.OPS.fill || operators.fnArray[index] === pdfjs.OPS.eoFill) && previousRectangle !== undefined) {
            lines.push(previousRectangle);
            previousRectangle = undefined;
        }
    }
    // Determine all the horizontal lines and vertical lines that make up the grid.  The following
    // is careful to ignore the short lines and small rectangles that make up the logo at the top
    // left of the page (otherwise these would cause problems due to the additional cells that
    // they would cause to be constructed later).
    let horizontalLines = [];
    let verticalLines = [];
    for (let line of lines) {
        if (line.height <= 2 && line.width >= 200) {
            // Identify a horizontal line (these typically extend across the width of the page).
            horizontalLines.push(line);
        }
        else if (line.width <= 2 && line.height >= 10) {
            // Identify a vertical line (note that these might not be very tall if there are not
            // many development applications in the grid).
            verticalLines.push(line);
        }
        else if (line.height >= 5 && line.width >= 200) {
            // Convert the header into two horizonal lines (the header is typically a rectangle
            // that extends across the width of the page).
            horizontalLines.push({ x: line.x, y: line.y, width: line.width, height: 1 });
            horizontalLines.push({ x: line.x, y: line.y + line.height, width: line.width, height: 1 });
        }
    }
    let verticalLineComparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);
    verticalLines.sort(verticalLineComparer);
    let horizontalLineComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);
    horizontalLines.sort(horizontalLineComparer);
    // Construct cells based on the grid of lines.
    let cells = [];
    for (let horizontalLineIndex = 0; horizontalLineIndex < horizontalLines.length - 1; horizontalLineIndex++) {
        for (let verticalLineIndex = 0; verticalLineIndex < verticalLines.length - 1; verticalLineIndex++) {
            let horizontalLine = horizontalLines[horizontalLineIndex];
            let nextHorizontalLine = horizontalLines[horizontalLineIndex + 1];
            let verticalLine = verticalLines[verticalLineIndex];
            let nextVerticalLine = verticalLines[verticalLineIndex + 1];
            cells.push({ elements: [], x: verticalLine.x, y: horizontalLine.y, width: nextVerticalLine.x - verticalLine.x, height: nextHorizontalLine.y - horizontalLine.y });
        }
    }
    return cells;
}
// Parses the text elements from a page of a PDF.
async function parseElements(page) {
    let textContent = await page.getTextContent();
    // Find all the text elements.
    let elements = textContent.items.map(item => {
        let transform = item.transform;
        // Work around the issue https://github.com/mozilla/pdf.js/issues/8276 (heights are
        // exaggerated).  The problem seems to be that the height value is too large in some
        // PDFs.  Provide an alternative, more accurate height value by using a calculation
        // based on the transform matrix.
        let workaroundHeight = Math.sqrt(transform[2] * transform[2] + transform[3] * transform[3]);
        let x = transform[4];
        let y = transform[5];
        let width = item.width;
        let height = workaroundHeight;
        return { text: item.str, x: x, y: y, width: width, height: height };
    });
    return elements;
}
// Parses a PDF document.
async function parsePdf(url) {
    console.log(`Reading development applications from ${url}.`);
    let developmentApplications = [];
    // Read the PDF.
    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    // Parse the PDF.  Each page has the details of multiple applications.
    let receivedDateHeadingElement;
    let lotNumberHeadingElement;
    let houseNumberHeadingElement;
    let streetNameHeadingElement;
    let planHeadingElement;
    let suburbNameHeadingElement;
    let descriptionHeadingElement;
    let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
        console.log(`Reading and parsing applications from page ${pageIndex + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(pageIndex + 1);
        // Construct cells (ie. rectangles) based on the horizontal and vertical line segments
        // in the PDF page.
        let cells = await parseCells(page);
        // Construct elements based on the text in the PDF page.
        let elements = await parseElements(page);
        // The co-ordinate system used in a PDF is typically "upside done" so invert the
        // co-ordinates (and so this makes the subsequent logic easier to understand).
        for (let cell of cells)
            cell.y = -(cell.y + cell.height);
        for (let element of elements)
            element.y = -(element.y + element.height);
        // Sort the cells by approximate Y co-ordinate and then by X co-ordinate.
        let cellComparer = (a, b) => (Math.abs(a.y - b.y) < 2) ? ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)) : ((a.y > b.y) ? 1 : -1);
        cells.sort(cellComparer);
        // Sort the text elements by approximate Y co-ordinate and then by X co-ordinate.
        let elementComparer = (a, b) => (Math.abs(a.y - b.y) < 1) ? ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)) : ((a.y > b.y) ? 1 : -1);
        elements.sort(elementComparer);
        // Find the first column of elements.  Each element in the first column should contain
        // a development application number, for example, "371/002/17" or a column heading, for
        // example, "DEV NO.".
        let leftmostElement = elements.reduce(((previous, current) => previous === undefined ? current : (current.x < previous.x ? current : previous)), undefined);
        let leftmostElements = elements.filter(element => Math.abs(element.x - leftmostElement.x) < 10);
        let yComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);
        leftmostElements.sort(yComparer);
        // Use the first column of elements as anchor points (the bottom, left corner is the best
        // starting point as all text for a line is bottom justified relative to the development
        // application number element).
        for (let index = 0; index < leftmostElements.length; index++) {
            let row = elements.filter(element => element.y <= leftmostElements[index].y && (index === 0 || element.y > leftmostElements[index - 1].y));
            let leftmostElement = leftmostElements[index];
            if (index === 0 && leftmostElement.text.toUpperCase().replace(/[^A-Z]/g, "") === "DEVNO") {
                // Column headings.
                receivedDateHeadingElement = row.find(element => element.text.toUpperCase().replace(/[^A-Z]/g, "") === "LODGED");
                lotNumberHeadingElement = row.find(element => element.text.toUpperCase().replace(/[^A-Z]/g, "") === "LOTNO");
                houseNumberHeadingElement = row.find(element => element.text.toUpperCase().replace(/[^A-Z]/g, "") === "STNO");
                streetNameHeadingElement = row.find(element => element.text.toUpperCase().replace(/[^A-Z]/g, "") === "STNAME");
                planHeadingElement = row.find(element => element.text.toUpperCase().replace(/[^A-Z]/g, "") === "FPDP");
                suburbNameHeadingElement = row.find(element => element.text.toUpperCase().replace(/[^A-Z]/g, "") === "SUBURBHDOF");
                descriptionHeadingElement = row.find(element => element.text.toUpperCase().replace(/[^A-Z]/g, "") === "DESCRIPTIONOFDEVELOPMENT");
            }
            else {
                // Development application details.
                let receivedDateElements = row.filter(element => getHorizontalOverlapPercentage(receivedDateHeadingElement, element) > 0);
                let lotNumberElements = row.filter(element => getHorizontalOverlapPercentage(lotNumberHeadingElement, element) > 0);
                let houseNumberElements = row.filter(element => getHorizontalOverlapPercentage(houseNumberHeadingElement, element) > 0);
                let streetNameElements = row.filter(element => getHorizontalOverlapPercentage(streetNameHeadingElement, element) > 0);
                let planElements = row.filter(element => getHorizontalOverlapPercentage(planHeadingElement, element) > 0);
                let suburbNameElements = row.filter(element => getHorizontalOverlapPercentage(suburbNameHeadingElement, element) > 0);
                let descriptionElements = row.filter(element => getHorizontalOverlapPercentage(descriptionHeadingElement, element) > 0);
                // Get the application number.
                let applicationNumber = leftmostElements[index].text.replace(/\s/g, "").trim();
                // Get the received date.
                let receivedDate = moment.invalid();
                if (receivedDateElements !== undefined)
                    receivedDate = moment(receivedDateElements.map(element => element.text).join(" ").replace(/\s\s+/g, " ").trim(), "D-MMM-YY", true);
                // Get the lot number.
                let lotNumber = "";
                if (lotNumberElements !== undefined)
                    lotNumber = lotNumberElements.map(element => element.text).join(" ").replace(/\s\s+/g, " ").trim();
                // Get the house number.
                let houseNumber = "";
                if (houseNumberElements !== undefined)
                    houseNumber = houseNumberElements.map(element => element.text).join(" ").replace(/\s\s+/g, " ").trim();
                // Get the street name.
                let streetName = "";
                if (streetNameElements !== undefined)
                    streetName = streetNameElements.map(element => element.text).join(" ").replace(/\s\s+/g, " ").trim();
                // Get the plan.
                let plan = "";
                if (planElements !== undefined)
                    plan = planElements.map(element => element.text).join(" ").replace(/\s\s+/g, " ").trim();
                // Get the suburb name.
                let suburbName = "";
                let hundredName = "";
                if (suburbNameElements !== undefined)
                    suburbName = suburbNameElements.map(element => element.text).join(" ").replace(/\s\s+/g, " ").trim();
                let suburbNameTokens = suburbName.split("/");
                if (suburbNameTokens.length === 2) {
                    if (/^HD /.test(suburbNameTokens[1].trim())) {
                        hundredName = suburbNameTokens[1].trim(); // for example, "EMU FLAT/HD CLARE"
                        suburbName = suburbNameTokens[0].trim();
                    }
                    else {
                        hundredName = suburbNameTokens[0].trim(); // for example, "HD CLARE/EMU FLAT" or "WATERLOO / MARRABEL"
                        suburbName = suburbNameTokens[1].trim();
                    }
                }
                hundredName = hundredName.replace(/^HD /i, "");
                suburbName = suburbName.replace(/^HD /i, "");
                // Get the description.
                let description = "";
                if (descriptionElements !== undefined)
                    description = descriptionElements.map(element => element.text).join(" ").replace(/\s\s+/g, " ").trim();
                if (description === "")
                    description = "No Description Provided";
                // Construct the legal description.
                let legalDescriptionItems = [];
                if (lotNumber !== "")
                    legalDescriptionItems.push(`Lot ${lotNumber}`);
                if (plan !== "")
                    legalDescriptionItems.push(`Plan ${plan}`);
                if (hundredName !== "")
                    legalDescriptionItems.push(`Hundred ${hundredName}`);
                let legalDescription = legalDescriptionItems.join(", ");
                // Create an object containing all details of the development application.
                let developmentApplication = developmentApplications[applicationNumber];
                if (developmentApplication === undefined) {
                    developmentApplication =
                        {
                            applicationNumber: applicationNumber,
                            address: "",
                            description: "No Description Provided",
                            informationUrl: url,
                            commentUrl: CommentUrl,
                            scrapeDate: moment().format("YYYY-MM-DD"),
                            receivedDate: "",
                            legalDescription: ""
                        };
                    developmentApplications[applicationNumber] = developmentApplication;
                }
                if (receivedDateHeadingElement !== undefined)
                    developmentApplication.receivedDate = receivedDate.isValid() ? receivedDate.format("YYYY-MM-DD") : "";
                if (houseNumberHeadingElement !== undefined || streetNameHeadingElement !== undefined || suburbNameHeadingElement !== undefined)
                    developmentApplication.address = formatAddress((streetName !== "" && suburbName !== "") ? `${houseNumber} ${streetName}, ${suburbName}` : "");
                if (lotNumberHeadingElement !== undefined || planHeadingElement !== undefined || suburbNameHeadingElement !== undefined)
                    developmentApplication.legalDescription = legalDescription;
                if (descriptionHeadingElement !== undefined)
                    developmentApplication.description = description;
            }
        }
    }
    for (let developmentApplication of developmentApplications)
        if (developmentApplication === "")
            console.log(`Ignoring development application ${developmentApplication.applicationNumber} because the address was blank (the street name or suburb name is blank).`);
    return Object.values(developmentApplications).filter(developmentApplication => developmentApplication.address !== "");
}
// Gets a random integer in the specified range: [minimum, maximum).
function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}
// Pauses for the specified number of milliseconds.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
// Parses the development applications.
async function main() {
    // Ensure that the database exists.
    let database = await initializeDatabase();
    // Read all street, street suffix and suburb information.
    readAddressInformation();
    // Read the main page of development applications.
    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);
    let body = await request({ url: DevelopmentApplicationsUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);
    let pdfUrls = [];
    for (let element of $("p a").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
        if (pdfUrl.toLowerCase().includes(".pdf"))
            if (!pdfUrls.some(url => url === pdfUrl)) // avoid duplicates
                pdfUrls.push(pdfUrl);
    }
    // Always parse the most recent PDF file and randomly select one other PDF file to parse.
    if (pdfUrls.length === 0) {
        console.log("No PDF URLs were found on the page.");
        return;
    }
    console.log(`Found ${pdfUrls.length} PDF file(s).  Selecting two to parse.`);
    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).
    let selectedPdfUrls = [];
    selectedPdfUrls.push(pdfUrls.shift());
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(0, pdfUrls.length)]);
    if (getRandom(0, 2) === 0)
        selectedPdfUrls.reverse();
    // for (let pdfUrl of selectedPdfUrls) {
    for (let pdfUrl of ["https://www.claregilbertvalleys.sa.gov.au/webdata/resources/files/Website%20Development%20Register%202016.pdf"]) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development ${(developmentApplications.length == 1) ? "application" : "applications"} from document: ${pdfUrl}`);
        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the
        // current process being terminated by morph.io).
        if (global.gc)
            global.gc();
        console.log("Inserting development applications into the database.");
        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}
main().then(() => console.log("Complete.")).catch(error => console.error(error));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsZ0dBQWdHO0FBQ2hHLDBDQUEwQztBQUMxQyxFQUFFO0FBQ0YsZUFBZTtBQUNmLG9CQUFvQjtBQUVwQixZQUFZLENBQUM7O0FBRWIseUJBQXlCO0FBQ3pCLG1DQUFtQztBQUNuQyxrREFBa0Q7QUFDbEQsbUNBQW1DO0FBQ25DLGlDQUFpQztBQUNqQyxpQ0FBaUM7QUFDakMsb0NBQW9DO0FBQ3BDLHlFQUFzRDtBQUV0RCxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFFbEIsTUFBTSwwQkFBMEIsR0FBRywyREFBMkQsQ0FBQztBQUMvRixNQUFNLFVBQVUsR0FBRyw2QkFBNkIsQ0FBQztBQUlqRCx1QkFBdUI7QUFFdkIsSUFBSSxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBQ3ZCLElBQUksY0FBYyxHQUFJLElBQUksQ0FBQztBQUMzQixJQUFJLFdBQVcsR0FBRyxJQUFJLENBQUM7QUFFdkIsOEJBQThCO0FBRTlCLEtBQUssVUFBVSxrQkFBa0I7SUFDN0IsT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtRQUNuQyxJQUFJLFFBQVEsR0FBRyxJQUFJLE9BQU8sQ0FBQyxRQUFRLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDbkQsUUFBUSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUU7WUFDcEIsUUFBUSxDQUFDLEdBQUcsQ0FBQyx3TkFBd04sQ0FBQyxDQUFDO1lBQ3ZPLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUN0QixDQUFDLENBQUMsQ0FBQztJQUNQLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQztBQUVELG1FQUFtRTtBQUVuRSxLQUFLLFVBQVUsU0FBUyxDQUFDLFFBQVEsRUFBRSxzQkFBc0I7SUFDckQsT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUs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LENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzdILEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7UUFFekIsaUZBQWlGO1FBRWpGLElBQUksZUFBZSxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDaEksUUFBUSxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUUvQixzRkFBc0Y7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