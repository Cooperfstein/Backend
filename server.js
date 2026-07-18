require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;


const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});


console.log({
  adzunaID: !!ADZUNA_APP_ID,
  adzunaKey: !!ADZUNA_APP_KEY,
  openai: !!OPENAI_API_KEY
});



app.get("/", (req,res)=>{
  res.send("Job matcher backend is running.");
});





function cleanJob(job){

  return {

    title:
      job.title || "Unknown job",

    company:
      job.company?.display_name || "Unknown company",

    location:
      job.location?.display_name || "Location unavailable",

    salary_min:
      job.salary_min || null,

    salary_max:
      job.salary_max || null,

    contract_time:
      job.contract_time || "",

    description:
      (job.description || "")
      .replace(/<[^>]*>/g,"")
      .slice(0,500),


    // Adzuna's direct application link
    url:
      job.redirect_url || ""

  };

}





async function getAdzunaJobs(zip, searchTerm){

  const url =
    `https://api.adzuna.com/v1/api/jobs/us/search/1` +
    `?app_id=${ADZUNA_APP_ID}` +
    `&app_key=${ADZUNA_APP_KEY}` +
    `&results_per_page=25` +
    `&where=${encodeURIComponent(zip)}` +
    `&what=${encodeURIComponent(searchTerm)}` +
    `&sort_by=relevance`;



  console.log("Searching Adzuna:");
  console.log(url);



  const response =
    await fetch(url);



  if(!response.ok){

    const text =
      await response.text();

    throw new Error(
      "Adzuna error: " + text
    );

  }



  const data =
    await response.json();



  return (data.results || []).map(cleanJob);

}





app.post("/api/match", async(req,res)=>{


try{


const {
  age,
  zip,
  hobbies=[],
  skills=[],
  wage,
  hoursPerWeek

} = req.body;



if(!zip){

 return res.status(400).json({
   error:"Zip code required"
 });

}



if(
 !ADZUNA_APP_ID ||
 !ADZUNA_APP_KEY ||
 !OPENAI_API_KEY
){

 return res.status(500).json({
   error:"Missing API keys"
 });

}




// Start broad because Adzuna works better this way
let jobs =
 await getAdzunaJobs(
   zip,
   "part time"
 );




// If results are bad, expand search

if(jobs.length < 5){

 console.log(
  "Too few jobs. Expanding search."
 );


 const backup =
 await getAdzunaJobs(
   zip,
   "entry level"
 );


 const existing =
 new Set(
  jobs.map(j =>
    j.title + j.company
  )
 );


 backup.forEach(job=>{

   const key =
    job.title + job.company;


   if(!existing.has(key)){
      jobs.push(job);
   }

 });


}



if(jobs.length===0){

 return res.json({
   matches:[]
 });

}





const jobText =

jobs.map((job,index)=>`

JOB ${index+1}

Title:
${job.title}

Company:
${job.company}

Location:
${job.location}

Pay:
${job.salary_min || "Not listed"}

Schedule:
${job.contract_time || "Not listed"}

Description:
${job.description}

`).join("\n");




const prompt = `

You are an expert career counselor helping teenagers find their first jobs.

Analyze the user's profile and compare it to the real job listings.

USER:

Age:
${age || "Unknown"}

Hobbies:
${hobbies.join(", ") || "None"}

Skills:
${skills.join(", ") || "None"}

Desired hourly pay:
${wage || "No preference"}

Desired weekly hours:
${hoursPerWeek || "No preference"}



JOB LIST:

${jobText}



Your task:

1. Evaluate every job.
2. Consider actual responsibilities, not just job titles.
3. Match hobbies and skills to the job.
4. Consider age appropriateness.
5. Consider pay and hours if available.
6. Rank the best jobs.

Return ONLY valid JSON.

Format:

[
 {
  "index":1,
  "matchScore":95,
  "reason":"Specific explanation"
 }
]

Return the top 10 matches.

`;



const aiResponse =
await openai.chat.completions.create({

 model:"gpt-5-mini",

 response_format:{
   type:"json_object"
 },

 messages:[

  {
   role:"system",
   content:
   "You match teenagers with suitable first jobs."
  },

  {
   role:"user",
   content:prompt
  }

 ]

});



const aiText =
aiResponse.choices[0]
.message.content;



let rankingData;


try{

 rankingData =
 JSON.parse(aiText);

}

catch(error){

 console.log(
  "AI JSON ERROR:",
  aiText
 );

 throw new Error(
  "AI returned invalid JSON"
 );

}
const rankingArray =
  rankingData.matches || rankingData;



const matches =

rankingArray

.map(rank=>{

  const job =
    jobs[rank.index - 1];


  if(!job)
    return null;


  return {

    ...job,

    matchScore:
      rank.matchScore,

    reason:
      rank.reason

  };


})

.filter(Boolean);



res.json({

 matches

});



}

catch(error){


 console.error(
  "MATCH ERROR:",
  error
 );


 res.status(500).json({

   error:error.message

 });


}



});






app.listen(PORT,()=>{

 console.log(
  `Backend running on port ${PORT}`
 );

});